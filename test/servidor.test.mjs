// HTTP layer: session binding and isolation, CSRF and Origin checks on every mutation, advisory budget,
// and the protected sandbox mode (operator login, no public orders). The sandbox here is backed by the fixture: no PayPal call.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { criarApp } from '../src/app.mjs';
import { PayPalFixture } from '../src/paypal-fixture.mjs';
import { StoreMemoria } from '../src/store.mjs';

const abertos = [];
after(() => { for (const s of abertos) { s.closeAllConnections(); s.close(); } });

async function subir(config) {
  const porta = await new Promise((ok) => { const t = createNetServer().listen(0, '127.0.0.1', () => { const n = t.address().port; t.close(() => ok(n)); }); });
  const app = criarApp({ ...config, baseUrl: `http://127.0.0.1:${porta}` });
  await new Promise((r) => app.servidor.listen(porta, '127.0.0.1', r));
  abertos.push(app.servidor);
  return { ...app, origem: `http://127.0.0.1:${porta}`, porta };
}

/** Minimal browser stand-in: keeps its own cookie and CSRF token. */
function visitante(srv) {
  const v = { cookie: '', csrf: '' };
  v.req = (metodo, caminho, { corpo, headers = {}, semCsrf, origem = srv.origem } = {}) => new Promise((ok, falha) => {
    const h = { ...headers };
    if (v.cookie) h.cookie = v.cookie;
    if (metodo === 'POST') { if (origem) h.origin = origem; if (!semCsrf) h['x-cg-csrf'] = v.csrf; h['content-type'] = 'application/json'; }
    const r = request({ host: '127.0.0.1', port: srv.porta, path: caminho, method: metodo, headers: h }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; });
      res.on('end', () => {
        const sc = res.headers['set-cookie']?.[0]; if (sc) v.cookie = sc.split(';')[0];
        let j = null; try { j = JSON.parse(t); } catch {}
        ok({ st: res.statusCode, j, headers: res.headers });
      });
    });
    r.on('error', falha); if (corpo !== undefined) r.write(typeof corpo === 'string' ? corpo : JSON.stringify(corpo)); r.end();
  });
  v.entrar = async () => { const r = await v.req('GET', '/api/info'); v.csrf = r.j.csrf; return r; };
  return v;
}

test('fixture: session cookie is HttpOnly and SameSite=Strict; orders are bound to the visitor who created them', async () => {
  const srv = await subir({ modo: 'fixture' });
  const a = visitante(srv), b = visitante(srv);
  const info = await a.entrar(); await b.entrar();
  assert.match(info.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  const p = (await a.req('POST', '/api/pedidos')).j;
  assert.equal(p.estado, 'AUTHORIZED');
  assert.equal((await a.req('GET', `/api/pedidos/${p.id}`)).st, 200);
  const outro = await b.req('GET', `/api/pedidos/${p.id}`);
  assert.deepEqual([outro.st, outro.j.codigo], [404, 'ORDER_NOT_FOUND'], 'another visitor sees "not found"');
  assert.equal((await b.req('POST', `/api/pedidos/${p.id}/entrega?lote=L0.csv`)).st, 404);
  assert.equal((await b.req('POST', `/api/pedidos/${p.id}/anular`, { corpo: { confirmo: true } })).st, 404);
  const anon = visitante(srv);
  assert.equal((await anon.req('GET', `/api/pedidos/${p.id}`)).st, 404);
  assert.equal((await a.req('POST', `/api/pedidos/${p.id}/entrega?lote=L0.csv`)).j.estado, 'CHECKED');
});

test('fixture: every mutation needs the session CSRF token and a same-origin Origin header', async () => {
  const srv = await subir({ modo: 'fixture' });
  const a = visitante(srv), b = visitante(srv);
  await a.entrar(); await b.entrar();
  const id = (await a.req('POST', '/api/pedidos')).j.id;
  const sem = await a.req('POST', `/api/pedidos/${id}/entrega?lote=L0.csv`, { semCsrf: true });
  assert.deepEqual([sem.st, sem.j.codigo], [403, 'CSRF']);
  const errado = await a.req('POST', `/api/pedidos/${id}/entrega?lote=L0.csv`, { headers: { 'x-cg-csrf': b.csrf }, semCsrf: true });
  assert.deepEqual([errado.st, errado.j.codigo], [403, 'CSRF'], "another session's token is refused");
  const fora = await a.req('POST', `/api/pedidos/${id}/entrega?lote=L0.csv`, { origem: 'https://evil.example' });
  assert.deepEqual([fora.st, fora.j.codigo], [403, 'BAD_ORIGIN']);
  const semOrigem = await a.req('POST', `/api/pedidos/${id}/entrega?lote=L0.csv`, { origem: null });
  assert.deepEqual([semOrigem.st, semOrigem.j.codigo], [403, 'BAD_ORIGIN']);
  const anon = visitante(srv);
  assert.deepEqual((await anon.req('POST', '/api/pedidos')).j.codigo, 'NO_SESSION');
  assert.equal((await a.req('GET', `/api/pedidos/${id}`)).j.estado, 'AUTHORIZED', 'nothing changed');
  assert.equal((await a.req('POST', '/api/login', { corpo: { token: 'x' } })).st, 404, 'no login in fixture mode');
});

test('fixture: advisory calls are capped per session even across orders, counted before the call', async () => {
  let chamadas = 0;
  const srv = await subir({ modo: 'fixture', gerar: async () => { chamadas++; return 'Line 3: sku is required.'; }, limites: { llmPorSessao: 2, llmPorPedido: 5 } });
  const a = visitante(srv); await a.entrar();
  const res = [];
  for (let i = 0; i < 2; i++) {
    const id = (await a.req('POST', '/api/pedidos')).j.id;
    await a.req('POST', `/api/pedidos/${id}/entrega?lote=L0-V2.csv`);
    res.push((await a.req('POST', `/api/pedidos/${id}/parecer`)).j.parecer, (await a.req('POST', `/api/pedidos/${id}/parecer`)).j.parecer);
  }
  assert.equal(chamadas, 2);
  assert.deepEqual(res.slice(2).map((p) => p.motivo), ['advisory budget reached', 'advisory budget reached']);
});

test('fixture: order creation is capped per session', async () => {
  const srv = await subir({ modo: 'fixture', limites: { pedidosPorSessao: 2 } });
  const a = visitante(srv); await a.entrar();
  assert.equal((await a.req('POST', '/api/pedidos')).st, 201); assert.equal((await a.req('POST', '/api/pedidos')).st, 201);
  assert.deepEqual((await a.req('POST', '/api/pedidos')).j.codigo, 'ORDER_LIMIT');
});

const TOKEN = 'operator-test-token-not-a-secret';
const HASH = createHash('sha256').update(TOKEN).digest('hex');

test('sandbox: refuses to start without an operator token hash, a PayPal client or a store', () => {
  assert.throws(() => criarApp({ modo: 'sandbox', baseUrl: 'http://x', paypal: new PayPalFixture(), store: new StoreMemoria() }), /OPERATOR_TOKEN_SHA256/);
  assert.throws(() => criarApp({ modo: 'sandbox', baseUrl: 'http://x', operadorSha256: HASH }), /PayPal client/);
});

test('sandbox: no public orders; operator login rotates the session; webhook route closed without a verifier; GET return changes nothing', async () => {
  const pp = new PayPalFixture();
  const srv = await subir({ modo: 'sandbox', paypal: pp, store: new StoreMemoria(), operadorSha256: HASH, limites: { falhasLogin: 3 } });
  const v = visitante(srv); await v.entrar();
  assert.deepEqual((await v.req('POST', '/api/pedidos')).j.codigo, 'OPERATOR_REQUIRED');
  assert.equal(pp.chamadas.length, 0);
  assert.deepEqual((await v.req('POST', '/api/login', { corpo: { token: 'wrong' } })).j.codigo, 'LOGIN_FAILED');
  const antes = v.cookie;
  const ok = await v.req('POST', '/api/login', { corpo: { token: TOKEN } });
  assert.equal(ok.st, 200); assert.notEqual(v.cookie, antes, 'new session id after login'); v.csrf = ok.j.csrf;
  const p = (await v.req('POST', '/api/pedidos')).j;
  assert.equal(p.estado, 'CREATED'); assert.equal(p.modo, 'sandbox');
  const velho = visitante(srv); velho.cookie = antes; velho.csrf = 'x';
  assert.equal((await velho.req('GET', `/api/pedidos/${p.id}`)).st, 401, 'the pre-login session is gone');
  const r = await v.req('GET', `/retorno?token=${p.order_id}`);
  assert.deepEqual([r.st, r.headers.location], [302, `/#${p.id}`]);
  assert.equal((await v.req('GET', `/api/pedidos/${p.id}`)).j.estado, 'CREATED', 'GET /retorno did not authorize');
  assert.equal((await v.req('POST', `/api/pedidos/${p.id}/autorizar`)).j.estado, 'AUTHORIZED');
  const wh = visitante(srv);
  assert.equal((await wh.req('POST', '/webhooks/paypal', { corpo: {}, origem: null, semCsrf: true })).st, 404);
  const outro = visitante(srv); await outro.entrar();
  for (let i = 0; i < 3; i++) await outro.req('POST', '/api/login', { corpo: { token: 'nope' } });
  assert.deepEqual((await outro.req('POST', '/api/login', { corpo: { token: TOKEN } })).j.codigo, 'LOGIN_LOCKED', 'lockout after repeated failures');
});

test('C2a: the resend action no longer exists over HTTP (fixture and sandbox), and no POST reaches PayPal', async () => {
  const f = await subir({ modo: 'fixture' });
  const a = visitante(f); await a.entrar();
  const id = (await a.req('POST', '/api/pedidos')).j.id;
  const r = await a.req('POST', `/api/pedidos/${id}/reenviar`, { corpo: { confirmo: true } });
  assert.deepEqual([r.st, r.j.erro], [404, 'unknown action']);
  const pp = new PayPalFixture({ cortar: ['create'] });
  const s = await subir({ modo: 'sandbox', paypal: pp, store: new StoreMemoria(), operadorSha256: HASH });
  const v = visitante(s); await v.entrar();
  v.csrf = (await v.req('POST', '/api/login', { corpo: { token: TOKEN } })).j.csrf;
  const p = (await v.req('POST', '/api/pedidos')).j;
  assert.deepEqual([p.estado, p.incerto], ['UNCERTAIN', 'create']);
  const antes = pp.chamadas.length;
  for (const acao of ['reenviar', 'autorizar', 'capturar', 'anular', 'reautorizar', 'reconciliar']) await v.req('POST', `/api/pedidos/${p.id}/${acao}`, { corpo: { confirmo: true, li_rejeicoes: true } });
  assert.equal(pp.chamadas.length - antes, 0);
  assert.equal((await v.req('GET', `/api/pedidos/${p.id}`)).j.estado, 'UNCERTAIN');
});
