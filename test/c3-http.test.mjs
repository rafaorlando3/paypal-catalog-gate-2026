// C3 over HTTP: suggestion actions keep CSRF and session binding, the adapter is OFF by default, reserved lots are never served.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { criarApp } from '../src/app.mjs';

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

import { criarAdaptadorIA } from '../src/c3/adaptador.mjs';

test('C3 HTTP: suggest, decide and build the request; adapter OFF by default; another visitor gets 404', async () => {
  const srv = await subir({ modo: 'fixture' });
  const a = visitante(srv), b = visitante(srv);
  const info = (await a.entrar()).j; await b.entrar();
  assert.equal(info.sugestoes_ia, false);
  assert.ok(info.lotes.includes('C3-V7-dev-es.csv') && info.lotes.includes('C3-V8-dev-pt.csv'));
  assert.ok(!info.lotes.some((n) => n.includes('reservado')), 'reserved lots are never served');
  const id = (await a.req('POST', '/api/pedidos')).j.id;
  assert.equal((await a.req('POST', `/api/pedidos/${id}/entrega?lote=C3-V7-dev-es.csv`)).j.cor, 'vermelho');
  assert.equal((await a.req('POST', `/api/pedidos/${id}/entrega?lote=C3-H1-reservado-es.csv`)).j.codigo, 'FILE');
  assert.equal((await a.req('POST', `/api/pedidos/${id}/sugerir`, { semCsrf: true })).j.codigo, 'CSRF');
  const v = (await a.req('POST', `/api/pedidos/${id}/sugerir`, { corpo: {} })).j;
  assert.equal(v.sugestoes.ia.estado, 'disabled');
  assert.equal(v.estado, 'CHECKED'); assert.equal(v.cor, 'vermelho');
  assert.equal((await b.req('POST', `/api/pedidos/${id}/sugerir`, { corpo: {} })).st, 404);
  const d = (await a.req('POST', `/api/pedidos/${id}/decidir_sugestao`, { corpo: { sid: 'rejeicao:20:stock', fonte: 'b1', aceitar: true, confirmo: true } })).j;
  assert.equal(d.sugestoes.itens.find((i) => i.sid === 'rejeicao:20:stock').decisao.valor, '12');
  assert.equal((await a.req('POST', `/api/pedidos/${id}/decidir_sugestao`, { corpo: { sid: 'rejeicao:20:stock', fonte: 'b1', aceitar: true } })).j.codigo, 'NO_HUMAN_CLICK');
  const r = (await a.req('POST', `/api/pedidos/${id}/pedido_reentrega`, { corpo: { idioma: 'pt' } })).j;
  assert.match(r.texto_reentrega, /Linha 20, stock: trocar "doce" por "12"\./);
  assert.equal((await a.req('POST', `/api/pedidos/${id}/pedido_reentrega`, { corpo: { idioma: 'en' } })).j.codigo, 'LANGUAGE');
  assert.equal(r.captura_disponivel, false, 'FAIL verdict unchanged');
});

test('C3 HTTP: an injected adapter is bounded by the session advisory budget', async () => {
  let n = 0;
  const ia = criarAdaptadorIA({ habilitado: true, modelo: 'test-double', provedor: async () => { n++; return '{"propostas":[]}'; } });
  const srv = await subir({ modo: 'fixture', ia, limites: { llmPorSessao: 1, llmPorPedido: 5 } });
  const a = visitante(srv); await a.entrar();
  const id = (await a.req('POST', '/api/pedidos')).j.id;
  await a.req('POST', `/api/pedidos/${id}/entrega?lote=C3-V8-dev-pt.csv`);
  assert.equal((await a.req('POST', `/api/pedidos/${id}/sugerir`, { corpo: {} })).j.sugestoes.ia.estado, 'checked');
  const s2 = (await a.req('POST', `/api/pedidos/${id}/sugerir`, { corpo: {} })).j.sugestoes.ia;
  assert.deepEqual([n, s2.estado, s2.motivo], [1, 'unavailable', 'advisory budget reached']);
});
