// C3a-U1 regressions (PREPARED in C3a-U1, not executed by Claude). Part of `npm test`.
//  - Part A: the real web/app.js runs in a vm with a minimal DOM and a fetch whose answers the test holds and releases
//    in any order (deferred network). It exercises the ticket/epoch logic on the shipped bytes, not a copy.
//  - Part B: advisory generator failures reach the store, trail and HTTP view only as fixed public texts.
// The browser counterpart against a fixture-mode server is test/e2e/c3au1-respostas-atrasadas.e2e.cjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { request } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { criarApp } from '../src/app.mjs';
import { erroIA, ERROS_IA } from '../src/c3/adaptador.mjs';

const APP = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const VINCULO = readFileSync(new URL('../web/vinculo-reentrega.js', import.meta.url), 'utf8');
const INFO = { csrf: 'csrf-u1', login_exigido: false, operador: null, modo: 'fixture', sugestoes_ia: false, parecer: false,
  brief: { colunas: [{ nome: 'sku' }], linhas_esperadas: 200, tolerancia_rejeicao: 0.05, chave: 'sku' }, lotes: ['L0.csv', 'C3-V7-dev-es.csv'] };
const esperar = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** A view as the server returns it, optionally with suggestions and a built-request binding. */
function vista(id, { revisao = 1, lote = `lote-${id}`, sugestoes = true, estado = 'CHECKED', trilha = [], reentrega = null, extra = {} } = {}) {
  const v = { id, order_id: `PP-${id}`, estado, trilha, avisos: [], alertas: [], relatorio: null, lote_sha256: lote, revisao_entrega: revisao,
    sugestoes: sugestoes ? { lote_sha256: lote, revisao_entrega: revisao, revisao: 1, ia: { estado: 'off' }, itens: [] } : null, ...extra };
  if (reentrega) v.reentrega = { pedido: id, lote_sha256: lote, revisao_entrega: revisao, revisao_sugestoes: 1, idioma: reentrega.idioma, texto: reentrega.texto };
  return v;
}

/** Loads the shipped page script with a stub DOM; every fetch waits until the test resolves it. */
async function pagina({ hash = '', semInfo = false } = {}) {
  const els = {};
  const el = (k) => (els[k] ??= { id: k, innerHTML: '', textContent: '', value: k === 'idioma' ? 'es' : k === 'lote' ? 'C3-V7-dev-es.csv' : '', hidden: false, disabled: false, checked: false });
  const pendentes = []; const chamadas = []; const ouvintes = {};
  const fetch = (path, opt = {}) => new Promise((ok, falha) => {
    const c = { path, method: opt.method || 'GET', body: opt.body, ok, falha };
    chamadas.push(c); pendentes.push(c);
  });
  let h = hash; // like a browser: reading gives '#id', assigning 'id' or '#id' stores the same address
  const location = { get hash() { return h ? `#${h}` : ''; }, set hash(v) { h = String(v).replace(/^#/, ''); } };
  const ctx = { document: { getElementById: el, querySelectorAll: () => [] }, location, window: { addEventListener: (n, f) => { ouvintes[n] = f; } }, fetch, console };
  runInNewContext(VINCULO, ctx); runInNewContext(APP, ctx);
  const responder = async (c, status, corpo) => { pendentes.splice(pendentes.indexOf(c), 1); c.ok({ ok: status < 400, status, json: async () => corpo }); await esperar(); };
  const proxima = (filtro) => { const c = pendentes.findLast(filtro); assert.ok(c, 'expected a pending request'); return c; }; // the latest match
  const pg = { els, el, ctx, chamadas, pendentes, ouvintes, responder, proxima, hash: () => h,
    navegar: async (alvo) => { h = alvo; ouvintes.hashchange(); await esperar(); },
    posts: () => chamadas.filter((c) => c.method === 'POST').map((c) => c.path),
    async clicar(k) { el(k).onclick(); await esperar(); },
    async mudar(k, valor) { el(k).value = valor; el(k).onchange({ target: el(k) }); await esperar(); },
    async criar(oid, opts) { await pg.clicar('novo'); await responder(proxima((c) => c.path === '/api/pedidos'), 200, vista(oid, opts)); },
    async acao(k, sufixo, corpo) { await pg.clicar(k); await responder(proxima((c) => c.path.endsWith(sufixo)), 200, corpo); },
  };
  pg.info = () => responder(proxima((c) => c.path === '/api/info'), 200, INFO);
  if (!semInfo) await pg.info();
  return pg;
}

test('U1-01: a Build of order A answered after New B changes nothing: B, its hash and no A text or error', async () => {
  const pg = await pagina();
  await pg.criar('A');
  await pg.clicar('montarPedido'); const build = pg.proxima((c) => c.path === '/api/pedidos/A/pedido_reentrega');
  await pg.criar('B');
  const antes = pg.chamadas.length;
  await pg.responder(build, 200, vista('A', { reentrega: { idioma: 'es', texto: 'TEXTO-A' } }));
  assert.equal(pg.hash(), 'B');
  assert.equal(pg.el('ordem').textContent.includes('PP-B'), true);
  assert.equal(pg.el('pedidoTxt').textContent, '');
  assert.equal(pg.el('erro').innerHTML, '');
  assert.equal(pg.chamadas.length, antes, 'the late answer triggers no request');
  assert.deepEqual(pg.posts(), ['/api/pedidos', '/api/pedidos/A/pedido_reentrega', '/api/pedidos']);
});

test('U1-02: a late New A never selects A, changes the hash or renders A; it is listed as created but not opened', async () => {
  const pg = await pagina();
  await pg.clicar('novo'); const novoA = pg.proxima((c) => c.path === '/api/pedidos');
  await pg.criar('B');
  await pg.responder(novoA, 200, vista('A'));
  assert.equal(pg.hash(), 'B');
  assert.ok(pg.el('ordem').textContent.includes('PP-B') && !pg.el('ordem').textContent.includes('PP-A'));
  assert.match(pg.el('avisos').innerHTML, /not opened: order A/);
  // An action now targets B, never A.
  await pg.clicar('sugerir'); assert.equal(pg.proxima((c) => c.path.endsWith('/sugerir')).path, '/api/pedidos/B/sugerir');
  // Reverse order: New C answered after New D, same rule.
  await pg.clicar('novo'); const c1 = pg.proxima((c) => c.path === '/api/pedidos');
  await pg.clicar('novo'); const c2 = pg.proxima((c) => c.path === '/api/pedidos');
  assert.notEqual(c1, c2);
  await pg.responder(c1, 200, vista('C')); assert.equal(pg.hash(), 'B', 'superseded New C does not select');
  await pg.responder(c2, 200, vista('D')); assert.equal(pg.hash(), 'D');
});

test('U1-03: a stale failure of order A, after New B or after navigating away, never shows or clears anything', async () => {
  const pg = await pagina();
  await pg.criar('A');
  await pg.clicar('sugerir'); const falhaA = pg.proxima((c) => c.path === '/api/pedidos/A/sugerir');
  await pg.criar('B');
  const ordem = pg.el('ordem').textContent;
  await pg.responder(falhaA, 409, { erro: 'STALE-A-FAILURE' });
  assert.equal(pg.el('erro').innerHTML, ''); assert.equal(pg.el('ordem').textContent, ordem);
  // Navigation: hash to A (read-only GET), action on A held, hash back to B, then A fails.
  await pg.navegar('A');
  assert.equal(pg.el('ordem').textContent, '', 'the view is cleared until the new selection answers');
  await pg.responder(pg.proxima((c) => c.path === '/api/pedidos/A' && c.method === 'GET'), 200, vista('A'));
  await pg.clicar('sugerir'); const falha2 = pg.proxima((c) => c.path === '/api/pedidos/A/sugerir');
  await pg.navegar('B');
  await pg.responder(pg.proxima((c) => c.path === '/api/pedidos/B' && c.method === 'GET'), 200, vista('B'));
  await pg.responder(falha2, 500, { erro: 'STALE-A-FAILURE-2' });
  assert.equal(pg.el('erro').innerHTML, ''); assert.ok(pg.el('ordem').textContent.includes('PP-B'));
});

test('U1-04: a build for delivery revision 1 answered after the redelivery of revision 2 adds no text and says the answer was discarded', async () => {
  const pg = await pagina();
  await pg.criar('A');
  await pg.clicar('montarPedido'); const build1 = pg.proxima((c) => c.path.endsWith('/pedido_reentrega'));
  await pg.acao('reentrega', '/reentrega', vista('A', { estado: 'AWAITING_REDELIVERY' }));
  await pg.acao('entregar', '/entrega?lote=C3-V7-dev-es.csv', vista('A', { revisao: 2, lote: 'lote-A2' }));
  await pg.responder(build1, 200, vista('A', { revisao: 1, reentrega: { idioma: 'es', texto: 'TEXTO-REV1' } }));
  assert.equal(pg.el('pedidoTxt').textContent, '');
  assert.match(pg.el('avisos').innerHTML, /earlier answer for this order was discarded/);
  assert.doesNotMatch(pg.el('avisos').innerHTML, /payment step/, 'a build is not a payment step');
  assert.equal(pg.posts().filter((p) => p.endsWith('/pedido_reentrega')).length, 1, 'never re-sent');
});

test('U1-05: language ES -> PT -> ES while a build is in flight does not revive that build by value', async () => {
  const pg = await pagina();
  await pg.criar('A');
  await pg.clicar('montarPedido'); const build = pg.proxima((c) => c.path.endsWith('/pedido_reentrega'));
  assert.equal(JSON.parse(build.body).idioma, 'es');
  await pg.mudar('idioma', 'pt'); await pg.mudar('idioma', 'es');
  await pg.responder(build, 200, vista('A', { reentrega: { idioma: 'es', texto: 'TEXTO-ES-VELHO' } }));
  assert.equal(pg.el('pedidoTxt').textContent, '');
  // A build requested after the language settled is shown normally.
  await pg.acao('montarPedido', '/pedido_reentrega', vista('A', { reentrega: { idioma: 'es', texto: 'TEXTO-ES-NOVO' } }));
  assert.equal(pg.el('pedidoTxt').textContent, 'TEXTO-ES-NOVO');
  // Away and back also hides an already shown text: it must be rebuilt.
  await pg.mudar('idioma', 'pt'); await pg.mudar('idioma', 'es');
  assert.equal(pg.el('pedidoTxt').textContent, '');
});

test('U1-06: two actions on the same order answered in reverse order: the latest intent governs, the financial notice stays, nothing is re-sent', async () => {
  for (const ordem of ['parecer-responde-primeiro', 'captura-responde-primeiro']) {
    const pg = await pagina();
    await pg.criar('A', { estado: 'CHECKED', extra: { captura_disponivel: true } });
    await pg.clicar('capturar'); const cap = pg.proxima((c) => c.path.endsWith('/capturar'));
    await pg.clicar('parecer'); const par = pg.proxima((c) => c.path.endsWith('/parecer'));
    const depois = vista('A', { estado: 'COMPLETED', trilha: [{ t: 't2', estado: 'COMPLETED', evento: 'advisory unavailable' }] });
    const capturada = vista('A', { estado: 'COMPLETED', trilha: [{ t: 't1', estado: 'COMPLETED', evento: 'captured' }] });
    if (ordem === 'parecer-responde-primeiro') { await pg.responder(par, 200, depois); await pg.responder(cap, 200, capturada); }
    else { await pg.responder(cap, 200, capturada); await pg.responder(par, 200, depois); }
    assert.match(pg.el('trilha').textContent, /advisory unavailable/, ordem);
    assert.doesNotMatch(pg.el('trilha').textContent, /captured/, `${ordem}: the superseded answer did not render`);
    assert.match(pg.el('avisos').innerHTML, /including a payment step/, ordem);
    assert.equal(pg.posts().filter((p) => p.endsWith('/capturar')).length, 1, `${ordem}: capture never re-sent`);
    assert.equal(pg.posts().filter((p) => p.endsWith('/reconciliar')).length, 0, `${ordem}: no automatic reconciliation POST`);
    // A read-only read started afterwards removes the notice (Reload).
    await pg.navegar('X');
    await pg.responder(pg.proxima((c) => c.path === '/api/pedidos/X'), 200, vista('X'));
    await pg.navegar('A');
    await pg.responder(pg.proxima((c) => c.path === '/api/pedidos/A' && c.method === 'GET'), 200, capturada);
    assert.doesNotMatch(pg.el('avisos').innerHTML, /discarded/, `${ordem}: notice cleared by a later read`);
  }
});

test('U1-07: normal sequential use, current-order failures and an action without an order behave as before', async () => {
  const pg = await pagina({ hash: 'A' });
  await pg.responder(pg.proxima((c) => c.path === '/api/pedidos/A'), 200, vista('A'));
  assert.ok(pg.el('ordem').textContent.includes('PP-A'));
  await pg.acao('montarPedido', '/pedido_reentrega', vista('A', { reentrega: { idioma: 'es', texto: 'TEXTO-ES' } }));
  assert.equal(pg.el('pedidoTxt').textContent, 'TEXTO-ES');
  await pg.clicar('sugerir'); await pg.responder(pg.proxima((c) => c.path.endsWith('/sugerir')), 409, { erro: 'CURRENT-FAILURE' });
  assert.match(pg.el('erro').innerHTML, /CURRENT-FAILURE/); assert.ok(pg.el('ordem').textContent.includes('PP-A'), 'view kept');
  await pg.acao('sugerir', '/sugerir', vista('A'));
  assert.equal(pg.el('erro').innerHTML, '', 'a later success clears the error');
  assert.doesNotMatch(pg.el('avisos').innerHTML, /discarded/);
  // Our own hash update after a creation is not a second selection.
  await pg.criar('B'); const n = pg.chamadas.length; pg.ouvintes.hashchange(); await esperar(); assert.equal(pg.chamadas.length, n);
  // No order selected: no request is sent.
  const vazia = await pagina();
  const m = vazia.chamadas.length; await vazia.clicar('sugerir');
  assert.equal(vazia.chamadas.length, m); assert.match(vazia.el('erro').innerHTML, /Create or open an order first/);
  // The initial read of #A is not issued over a click made while /api/info was loading.
  const p2 = await pagina({ hash: 'A', semInfo: true });
  await p2.clicar('novo'); const criado = p2.proxima((c) => c.path === '/api/pedidos');
  await p2.info();
  assert.equal(p2.chamadas.filter((c) => c.path === '/api/pedidos/A').length, 0, 'no initial read over a newer intent');
  await p2.responder(criado, 200, vista('N'));
  assert.equal(p2.hash(), 'N');
});

test('U1 static: financial actions are marked, no automatic retry, every action uses its ticket order', () => {
  for (const a of ['capturar', 'anular', 'reautorizar', 'autorizar']) assert.match(APP, new RegExp(`\\$\\('${a}'\\)\\.onclick = [^\\n]*financeiro: true \\}\\);`), a);
  assert.doesNotMatch(APP, /\/api\/pedidos\/\$\{id\}/, 'no action URL built from the mutable global id');
  assert.doesNotMatch(APP, /setTimeout|setInterval/, 'no timer that could re-send');
  const descartar = APP.slice(APP.indexOf('function descartar('), APP.indexOf('async function agir('));
  assert.ok(descartar.length > 0 && !/\bapi\(|\bagir\(|fetch\(/.test(descartar), 'a discarded answer never triggers a request');
  assert.deepEqual(APP.match(/(?<![\w.])id = [^;,]*/g), ['id = lerHash()', 'id = p.id', 'id = alvo'], 'id is set only at load, on creation acceptance and on hash navigation');
});

// ---------- Part B: advisory generator failures are sanitized before the order sees them ----------
const SENTINELA = 'sk-test-SENTINEL-c3au1-0000 https://provider.invalid/v1?key=SENTINEL-c3au1-0000';
const abertos = [];
after(() => { for (const s of abertos) { s.closeAllConnections(); s.close(); } });

test('U1 advisory: provider failures reach store, trail and HTTP only as fixed public texts; public codes and timeouts keep their code', async () => {
  const porta = await new Promise((ok) => { const t = createNetServer().listen(0, '127.0.0.1', () => { const n = t.address().port; t.close(() => ok(n)); }); });
  const origem = `http://127.0.0.1:${porta}`;
  let falha = null;
  const app = criarApp({ modo: 'fixture', baseUrl: origem, gerar: async () => { throw falha(); }, limites: { llmPorSessao: 50, llmPorDia: 50, llmPorPedido: 5 } });
  await new Promise((r) => app.servidor.listen(porta, '127.0.0.1', r)); abertos.push(app.servidor);
  let cookie = '', csrf = '';
  const req = (metodo, caminho, corpo) => new Promise((ok, erro) => {
    const h = cookie ? { cookie } : {};
    if (metodo === 'POST') Object.assign(h, { origin: origem, 'x-cg-csrf': csrf, 'content-type': 'application/json' });
    const r = request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers: h }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; });
      res.on('end', () => { const sc = res.headers['set-cookie']?.[0]; if (sc) cookie = sc.split(';')[0]; let j = null; try { j = JSON.parse(t); } catch {} ok({ st: res.statusCode, t, j }); });
    });
    r.on('error', erro); if (corpo !== undefined) r.write(JSON.stringify(corpo)); r.end();
  });
  csrf = (await req('GET', '/api/info')).j.csrf;
  const casos = [
    [() => new Error(SENTINELA), ERROS_IA.provider_error],
    [() => Object.assign(new Error('x'), { body: SENTINELA, url: SENTINELA, stack: SENTINELA }), ERROS_IA.provider_error],
    [() => ({ message: SENTINELA }), ERROS_IA.provider_error],
    [() => Object.assign(new Error(SENTINELA), { codigo: 'provider_timeout' }), ERROS_IA.provider_error], // forged code, no public mark
    [() => Object.assign(new Error(SENTINELA), { name: 'AbortError' }), ERROS_IA.provider_timeout],
    [() => erroIA('answer_too_large'), ERROS_IA.answer_too_large],
  ];
  for (const [fazer, esperado] of casos) {
    falha = fazer;
    const id = (await req('POST', '/api/pedidos', {})).j.id;
    await req('POST', `/api/pedidos/${id}/entrega?lote=L0-V2.csv`, {});
    const r = await req('POST', `/api/pedidos/${id}/parecer`, {});
    assert.equal(r.j.parecer.estado, 'unavailable'); assert.equal(r.j.parecer.motivo, esperado);
    const g = await req('GET', `/api/pedidos/${id}`);
    for (const t of [r.t, g.t]) assert.ok(!t.includes('SENTINEL'), 'no provider text in the HTTP body');
    assert.ok(g.j.trilha.some((x) => x.evento === 'advisory unavailable' && x.motivo === esperado), 'the trail keeps the fixed text');
  }
});
