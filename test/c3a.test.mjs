// C3a regressions for the four findings of the Codex static review of C3 (b6af6b3):
//   C3-01 the built supplier request is bound to order, lot, delivery revision, suggestion/decision revision, language;
//   C3-02 accepted exact values are written complete and verbatim; previews are labelled as previews;
//   C3-03 an AI answer that arrives after the delivery changed is discarded, never attached to the new delivery;
//   C3-04 provider errors reach store/view only as stable public codes; their message never does.
// Every provider here is a synthetic test double. PREPARED in C3a; execution belongs to the coordinated VPS/CI window.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { request } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { Mesa } from '../src/pedido.mjs';
import { PayPalFixture } from '../src/paypal-fixture.mjs';
import { StoreMemoria } from '../src/store.mjs';
import { B0 } from '../src/brief.mjs';
import { rowL0 } from '../src/gerar_l0.mjs';
import { criarAdaptadorIA, ERROS_IA } from '../src/c3/adaptador.mjs';
import { validarResposta } from '../src/c3/sugestoes.mjs';
import { textoReentrega, valorExatoSeguro } from '../src/c3/reentrega.mjs';
import { extrairAchados } from '../src/c3/achados.mjs';
import { validar } from '../src/validar.mjs';
import { criarApp } from '../src/app.mjs';

const lerC3 = (n) => readFileSync(new URL(`../fixtures/C3/${n}`, import.meta.url), 'utf8');
const AMOSTRA = readFileSync(new URL('../fixtures/L0/AMOSTRA-L0-linhas-2-11.csv', import.meta.url), 'utf8');
const V7 = lerC3('C3-V7-dev-es.csv'), V8 = lerC3('C3-V8-dev-pt.csv');
const SENTINELA = 'sk-test-SENTINEL-c3a-0000 https://provider.invalid/v1?key=SENTINEL-c3a-0000';

async function pronto(lote = V7, store = new StoreMemoria()) {
  const pp = new PayPalFixture();
  const m = new Mesa({ paypal: pp, brief: B0, amostra: AMOSTRA, store });
  await m.criar({ id: 'P1' }); await m.autorizar('P1'); m.entregar('P1', lote); m.conferir('P1');
  return { m, pp, store };
}

/** A provider whose answer is released by the test, to hold the AI call open while the delivery changes. */
function adiado() {
  let soltar; const chamadas = [];
  const provedor = ({ prompt }) => { chamadas.push(prompt); return new Promise((r) => { soltar = r; }); };
  return { ia: criarAdaptadorIA({ habilitado: true, modelo: 'test-double', timeoutMs: 60000, provedor }), chamadas, soltar: (t) => soltar(t) };
}
const espera = () => new Promise((r) => setImmediate(r));

// ---------- C3-01 ----------
const VR = (() => { const ctx = {}; runInNewContext(readFileSync(new URL('../web/vinculo-reentrega.js', import.meta.url), 'utf8'), ctx); return ctx.VinculoReentrega; })();
const vistaDe = (o = {}) => ({ id: 'P1', lote_sha256: 'L1', revisao_entrega: 2, sugestoes: { lote_sha256: 'L1', revisao_entrega: 2, revisao: 5 }, ...o });
const respostaDe = (o = {}) => ({ reentrega: { pedido: 'P1', lote_sha256: 'L1', revisao_entrega: 2, revisao_sugestoes: 5, idioma: 'es', texto: 'PEDIDO-ES', ...o } });

test('C3-01: the built request is shown only while order, lot, delivery revision, decisions and language are unchanged', () => {
  const g = VR.gerado(respostaDe());
  assert.equal(VR.textoVisivel(g, vistaDe(), 'es'), 'PEDIDO-ES', 'the render right after building keeps the fresh text');
  assert.equal(VR.textoVisivel(g, vistaDe({ id: 'P2' }), 'es'), '', 'another order');
  assert.equal(VR.textoVisivel(g, vistaDe({ lote_sha256: 'L2', sugestoes: { lote_sha256: 'L2', revisao_entrega: 2, revisao: 5 } }), 'es'), '', 'another lot');
  assert.equal(VR.textoVisivel(g, vistaDe({ revisao_entrega: 3, sugestoes: { lote_sha256: 'L1', revisao_entrega: 3, revisao: 5 } }), 'es'), '', 'same lot delivered and checked again');
  assert.equal(VR.textoVisivel(g, vistaDe({ sugestoes: { lote_sha256: 'L1', revisao_entrega: 2, revisao: 6 } }), 'es'), '', 'a decision changed');
  assert.equal(VR.textoVisivel(g, vistaDe(), 'pt'), '', 'language changed');
  assert.equal(VR.textoVisivel(g, vistaDe({ sugestoes: null }), 'es'), '', 'suggestions discarded by a new delivery');
  assert.equal(VR.textoVisivel(g, vistaDe({ revisao_entrega: 3 }), 'es'), '', 'suggestions from an older delivery revision');
  assert.equal(VR.textoVisivel(g, null, 'es'), '', 'no order');
  assert.equal(VR.textoVisivel(null, vistaDe(), 'es'), '', 'nothing built');
  assert.equal(VR.gerado({ texto_reentrega: 'X' }), null, 'a text without its binding is never shown');
  assert.equal(VR.gerado(respostaDe({ revisao_sugestoes: undefined })), null);
});

test('C3-01: the engine moves the revisions that the binding depends on', async () => {
  const { m } = await pronto(V7);
  const r0 = m.pedido('P1').revisao_entrega;
  await m.sugerir('P1');
  const v1 = m.pedidoReentregaVinculado('P1', 'es');
  assert.deepEqual([v1.pedido, v1.lote_sha256, v1.revisao_entrega, v1.idioma], ['P1', m.pedido('P1').lote_sha256, r0, 'es']);
  m.decidirSugestao('P1', 'rejeicao:20:stock', { fonte: 'b1', aceitar: true, humano: true });
  const v2 = m.pedidoReentregaVinculado('P1', 'es');
  assert.ok(v2.revisao_sugestoes > v1.revisao_sugestoes, 'a decision is a new revision');
  assert.notEqual(v2.texto, v1.texto);
  m.decidirSugestao('P1', 'rejeicao:20:stock', { aceitar: false, humano: true });
  assert.ok(m.pedidoReentregaVinculado('P1', 'es').revisao_sugestoes > v2.revisao_sugestoes, 'undoing a decision is also a new revision');
  await m.sugerir('P1');
  assert.ok(m.pedidoReentregaVinculado('P1', 'es').revisao_sugestoes > v2.revisao_sugestoes, 'rebuilt suggestions never reuse a revision');
  m.pedirReentrega('P1'); m.entregar('P1', V7); m.conferir('P1');
  assert.ok(m.pedido('P1').revisao_entrega >= r0 + 2, 'delivering and checking again move the delivery revision even for identical bytes');
  assert.throws(() => m.pedidoReentregaVinculado('P1', 'es'), /current delivery/);
});

// ---------- C3-02 ----------
test('C3-02: an accepted rebuilt line is written complete and verbatim, with price and stock at the end', async () => {
  const nome = `Producto ${'muy largo '.repeat(12)}069`.trim(); // well over 60 characters
  const base = Array.from({ length: 200 }, (_, i) => rowL0(i + 1));
  const L = 70; const cel = base[L - 2].split(','); cel[1] = nome; cel[2] = '4,05'; base[L - 2] = cel.join(',');
  const lote = ['sku,nombre,precio,stock', ...base].join('\n') + '\n';
  const { m } = await pronto(lote);
  const sg = await m.sugerir('P1');
  const it = sg.itens.find((i) => i.sid === `rejeicao:${L}:*`);
  const esperado = [cel[0], nome, '4.05', cel[3]].join(',');
  assert.equal(it.b1.valor, esperado, 'B1 rebuild is unambiguous ("05" cannot be a price)');
  m.decidirSugestao('P1', it.sid, { fonte: 'b1', aceitar: true, humano: true });
  for (const idioma of ['es', 'pt']) {
    const t = m.pedidoReentrega('P1', idioma);
    const linhas = t.split('\n');
    assert.ok(linhas.includes(`    ${esperado}`), `${idioma}: the exact line appears alone and complete`);
    assert.ok(linhas.find((x) => x === `    ${esperado}`).endsWith(`,4.05,${cel[3]}`), 'price and stock kept at the end');
    assert.match(t, idioma === 'es' ? /vista previa recortada: "[^"]{60}…"/ : /prévia cortada: "[^"]{60}…"/, 'the received line is labelled as a shortened preview');
    assert.ok(!/…/.test(linhas.find((x) => x.startsWith('    '))), 'the exact value never carries an ellipsis');
  }
});

test('C3-02: every accepted value is written byte for byte; values that cannot be written verbatim fall back to a generic line', () => {
  const longo = `ABC-0099,${'N'.repeat(150)},12.50,7`;
  const sg = { lote_sha256: 'x'.repeat(64), itens: [
    { sid: 'rejeicao:99:*', tipo: 'rejeicao', linha: 99, campo: '*', original: longo.replace('12.50', '12,50'), decisao: { aceitar: true, fonte: 'b1', valor: longo } },
    { sid: 'rejeicao:20:stock', tipo: 'rejeicao', linha: 20, campo: 'stock', original: 'doce', decisao: { aceitar: true, fonte: 'b1', valor: '12' } },
    { sid: 'rejeicao:21:stock', tipo: 'rejeicao', linha: 21, campo: 'stock', original: 'x', decisao: { aceitar: true, fonte: 'ia', valor: '1\n2' } },
  ] };
  const t = textoReentrega(sg, 'es', B0);
  assert.ok(t.split('\n').includes(`    ${longo}`));
  assert.ok(t.split('\n').includes('    12'));
  assert.ok(!t.includes('1\n2'), 'a value with a control character is never inserted');
  assert.match(t, /Línea 21, stock: indicar un número entero/);
  assert.equal(valorExatoSeguro('a b'), false);
  assert.equal(valorExatoSeguro(''), false);
  assert.equal(valorExatoSeguro('12.50'), true);
});

// ---------- C3-03 ----------
test('C3-03: an AI answer pending while a new lot is delivered is discarded and never attached to the new delivery', async () => {
  const store = new StoreMemoria();
  const { m } = await pronto(V7, store);
  const a = adiado();
  const pend = m.sugerir('P1', { ia: a.ia });
  await espera(); assert.equal(a.chamadas.length, 1, 'the AI call is open');
  const idsV7 = extrairAchados(validar(B0, V7, AMOSTRA), V7, B0).map((x) => x.id);
  m.pedirReentrega('P1'); m.entregar('P1', V8); m.conferir('P1');
  const novo = m.pedido('P1').lote_sha256;
  a.soltar(JSON.stringify({ propostas: [{ achado_id: idsV7.find((x) => x.endsWith(':stock')), acao: 'corrigir', valor_proposto: '12', motivo: 'old' }] }));
  const r = await pend;
  assert.equal(r.descartado, true);
  assert.notEqual(r.lote_sha256, novo, 'the discarded result names the old delivery');
  assert.equal(m.pedido('P1').sugestoes, undefined, 'nothing stored for the new delivery');
  assert.ok(!JSON.parse(store.dados).pedidos[0].sugestoes, 'nothing persisted either');
  assert.throws(() => m.decidirSugestao('P1', 'rejeicao:20:stock', { fonte: 'b1', aceitar: true, humano: true }), /current delivery/);
  assert.throws(() => m.pedidoReentrega('P1', 'es'), /current delivery/);
  assert.match(m.pedido('P1').trilha.at(-1).evento, /stale suggestions discarded/);
  const atual = await m.sugerir('P1');
  assert.equal(atual.lote_sha256, novo, 'fresh suggestions for the new delivery are built from it');
});

test('C3-03: the same bytes delivered and checked again during the wait still discard the old answer', async () => {
  const { m } = await pronto(V7);
  const a = adiado();
  const pend = m.sugerir('P1', { ia: a.ia });
  await espera();
  const sha = m.pedido('P1').lote_sha256;
  m.pedirReentrega('P1'); m.entregar('P1', V7); m.conferir('P1');
  assert.equal(m.pedido('P1').lote_sha256, sha, 'identical lot hash');
  a.soltar('{"propostas":[]}');
  assert.equal((await pend).descartado, true);
  assert.equal(m.pedido('P1').sugestoes, undefined);
});

test('C3-03: an answer that arrives with the delivery unchanged is stored, bound to that delivery', async () => {
  const { m } = await pronto(V7);
  const a = adiado();
  const pend = m.sugerir('P1', { ia: a.ia });
  await espera();
  a.soltar('{"propostas":[]}');
  const sg = await pend;
  assert.equal(sg.descartado, undefined);
  assert.deepEqual([sg.lote_sha256, sg.revisao_entrega, sg.ia.estado], [m.pedido('P1').lote_sha256, m.pedido('P1').revisao_entrega, 'checked']);
});

// ---------- C3-04 ----------
test('C3-04: a provider error is reduced to a public code; the sentinel never reaches state, store, log or trail', async () => {
  const casos = [
    async () => { throw new Error(SENTINELA); },
    async () => { throw Object.assign(new Error('x'), { body: SENTINELA, url: SENTINELA }); },
    async () => { throw { message: SENTINELA }; }, // non-Error rejection
    async () => { const e = new Error(SENTINELA); e.codigo = 'provider_timeout'; throw e; }, // forged code without the public mark
  ];
  for (const provedor of casos) {
    const store = new StoreMemoria();
    const { m } = await pronto(V7, store);
    const ia = criarAdaptadorIA({ habilitado: true, modelo: 'test-double', provedor });
    await assert.rejects(ia.propor('x'), (e) => e.codigo === 'provider_error' && !String(e.message).includes('SENTINEL'));
    const sg = await m.sugerir('P1', { ia });
    assert.deepEqual([sg.ia.estado, sg.ia.codigo, sg.ia.motivo], ['unavailable', 'provider_error', ERROS_IA.provider_error]);
    for (const [onde, txt] of [['state', JSON.stringify(m.pedido('P1'))], ['store', store.dados], ['log', JSON.stringify(m.log)]])
      assert.ok(!txt.includes('SENTINEL'), `sentinel leaked into ${onde}`);
  }
});

test('C3-04: timeout keeps its public code; schema errors never echo model-supplied text', async () => {
  const lento = criarAdaptadorIA({ habilitado: true, modelo: 'test-double', timeoutMs: 20, provedor: () => new Promise(() => {}) });
  await assert.rejects(lento.propor('x'), (e) => e.codigo === 'provider_timeout' && e.message === ERROS_IA.provider_timeout);
  const a = extrairAchados(validar(B0, V7, AMOSTRA), V7, B0);
  const r = validarResposta(JSON.stringify({ propostas: [{ achado_id: a[0].id, acao: 'pedir_ao_fornecedor', valor_proposto: null, motivo: 'x', SENTINEL_c3a: 1 }] }), a);
  assert.equal(r.ok, false); assert.ok(!r.motivo.includes('SENTINEL'));
});

const abertos = [];
after(() => { for (const s of abertos) { s.closeAllConnections(); s.close(); } });

test('C3-04 over HTTP: the public order view carries the code, never the provider message; the request answer carries its binding', async () => {
  const porta = await new Promise((ok) => { const t = createNetServer().listen(0, '127.0.0.1', () => { const n = t.address().port; t.close(() => ok(n)); }); });
  const origem = `http://127.0.0.1:${porta}`;
  const ia = criarAdaptadorIA({ habilitado: true, modelo: 'test-double', provedor: async () => { throw new Error(SENTINELA); } });
  const app = criarApp({ modo: 'fixture', baseUrl: origem, ia, limites: { llmPorSessao: 5, llmPorPedido: 5 } });
  await new Promise((r) => app.servidor.listen(porta, '127.0.0.1', r)); abertos.push(app.servidor);
  let cookie = '', csrf = '';
  const req = (metodo, caminho, corpo) => new Promise((ok, falha) => {
    const h = cookie ? { cookie } : {};
    if (metodo === 'POST') Object.assign(h, { origin: origem, 'x-cg-csrf': csrf, 'content-type': 'application/json' });
    const r = request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers: h }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; });
      res.on('end', () => { const sc = res.headers['set-cookie']?.[0]; if (sc) cookie = sc.split(';')[0]; let j = null; try { j = JSON.parse(t); } catch {} ok({ st: res.statusCode, t, j }); });
    });
    r.on('error', falha); if (corpo !== undefined) r.write(JSON.stringify(corpo)); r.end();
  });
  csrf = (await req('GET', '/api/info')).j.csrf;
  const id = (await req('POST', '/api/pedidos', {})).j.id;
  await req('POST', `/api/pedidos/${id}/entrega?lote=C3-V7-dev-es.csv`, {});
  const s = await req('POST', `/api/pedidos/${id}/sugerir`, {});
  assert.equal(s.j.sugestoes.ia.codigo, 'provider_error');
  assert.ok(!s.t.includes('SENTINEL'), 'raw HTTP body has no provider text');
  assert.ok(!(await req('GET', `/api/pedidos/${id}`)).t.includes('SENTINEL'));
  const p = (await req('POST', `/api/pedidos/${id}/pedido_reentrega`, { idioma: 'es' })).j;
  assert.deepEqual([p.reentrega.pedido, p.reentrega.lote_sha256, p.reentrega.revisao_entrega, p.reentrega.revisao_sugestoes, p.reentrega.idioma],
    [id, p.lote_sha256, p.revisao_entrega, p.sugestoes.revisao, 'es'], 'the request text comes with the exact dependencies of the view');
  assert.equal(p.texto_reentrega, p.reentrega.texto);
  const js = await req('GET', '/vinculo-reentrega.js');
  assert.equal(js.st, 200);
});
