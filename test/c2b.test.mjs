// C2b: the full HTTP answer (headers AND body) is read under one timeout and one catch. An answer that is not complete
// and well formed is UNCERTAIN, never a definitive refusal and never a success. Driven through the real PayPalRest
// client with an injected fetchImpl (no network, no credentials): the scripted "PayPal" below is a test double.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Mesa } from '../src/pedido.mjs';
import { PayPalRest } from '../src/paypal-rest.mjs';
import { StoreMemoria } from '../src/store.mjs';
import { B0 } from '../src/brief.mjs';

const ler = (n) => readFileSync(new URL(`../fixtures/L0/${n}`, import.meta.url), 'utf8');
const AMOSTRA = ler('AMOSTRA-L0-linhas-2-11.csv');

// ---------- answers ----------
const json = (status, obj) => () => ({ status, text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) });
const vazio = (status) => () => ({ status, text: async () => '' });
/** Headers arrive with a 2xx status, then reading the body fails (connection reset). */
const corpoFalha = (status) => () => ({ status, text: async () => { throw new TypeError('terminated: other side closed'); } });
/** Headers arrive, then the body never completes; only the client's own timeout ends it (abort). */
const corpoTrava = (status) => (init) => ({ status, text: () => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })))) });

const AUT = { id: 'A1', status: 'CREATED', amount: { currency_code: 'USD', value: '50.00' } };
const PADRAO = {
  'POST /v2/checkout/orders': json(201, { id: 'O1', status: 'CREATED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=O1' }] }),
  'POST /v2/checkout/orders/O1/authorize': json(201, { id: 'O1', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [AUT] } }] }),
  'POST /v2/payments/authorizations/A1/capture': json(201, { id: 'K1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '50.00' }, final_capture: true, supplementary_data: { related_ids: { authorization_id: 'A1' } } }),
  'POST /v2/payments/authorizations/A1/void': vazio(204),
  'GET /v2/payments/authorizations/A1': json(200, AUT),
  'GET /v2/checkout/orders/O1': json(200, { id: 'O1', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [AUT] } }] }),
};

/** Scripted sandbox double. `posts` lists every POST that reached it except the token call. */
function duble(trocas = {}) {
  const rotas = { ...PADRAO, ...trocas };
  const posts = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === '/v1/oauth2/token') return json(200, { access_token: 'T', expires_in: 3600 })();
    const chave = `${init.method} ${u.pathname}`;
    if (init.method === 'POST') posts.push({ chave, requestId: init.headers['PayPal-Request-Id'], redirect: init.redirect });
    const h = rotas[chave]; if (!h) return json(404, { name: 'RESOURCE_NOT_FOUND' })();
    return h(init);
  };
  return { posts, rotas, rest: new PayPalRest({ clientId: 'test-id', secret: 'test-secret', fetchImpl, timeoutMs: 50 }) };
}

async function ate(estado, d) {
  const m = new Mesa({ paypal: d.rest, brief: B0, amostra: AMOSTRA, store: new StoreMemoria() });
  await m.criar({ id: 'P1' }); if (estado === 'CREATED') return m;
  await m.autorizar('P1'); if (estado === 'AUTHORIZED') return m;
  m.entregar('P1', ler('L0.csv')); m.conferir('P1');
  return m;
}

/** Every human action that could send a POST, plus two GET reconciliations. Returns the number of new POSTs. */
async function tentarTudo(m, d) {
  const antes = d.posts.length; const ignora = (f) => f().catch(() => {});
  await ignora(() => m.criar({ id: 'P1' })); await ignora(() => m.autorizar('P1'));
  await ignora(() => m.capturar('P1', { humano: true, li_rejeicoes: true })); await ignora(() => m.anular('P1', { humano: true }));
  await ignora(() => m.reautorizar('P1', { humano: true })); await ignora(() => m.repetirCaptura('P1'));
  await ignora(() => m.reconciliar('P1')); await ignora(() => m.reconciliar('P1'));
  return d.posts.length - antes;
}

const OPS = {
  authorize: { rota: 'POST /v2/checkout/orders/O1/authorize', antes: 'CREATED', fazer: (m) => m.autorizar('P1') },
  capture: { rota: 'POST /v2/payments/authorizations/A1/capture', antes: 'CHECKED', fazer: (m) => m.capturar('P1', { humano: true }) },
  void: { rota: 'POST /v2/payments/authorizations/A1/void', antes: 'CHECKED', fazer: (m) => m.anular('P1', { humano: true }) },
};

for (const [op, o] of Object.entries(OPS)) {
  for (const [nome, falha] of [['2xx headers then the body read rejects', corpoFalha(op === 'void' ? 200 : 201)], ['2xx headers then the body hangs until the timeout aborts it', corpoTrava(200)]]) {
    test(`${op}: ${nome} gives UNCERTAIN(${op}), not a refusal; zero new POST afterwards`, async () => {
      const d = duble();
      const m = await ate(o.antes, d);
      d.rotas[o.rota] = falha;
      await o.fazer(m);
      const p = m.pedido('P1');
      assert.deepEqual([p.estado, p.incerto], ['UNCERTAIN', op], 'not reverted to the previous state, not declined');
      assert.ok(p.pendente, 'the journaled intent is kept');
      assert.match(p.trilha.at(-1).evento, new RegExp(`no complete answer from PayPal for ${op}`));
      assert.equal(d.posts.filter((x) => x.chave === o.rota).length, 1);
      d.rotas[o.rota] = () => { throw new Error('a second POST must never be sent'); };
      assert.equal(await tentarTudo(m, d), 0);
    });
  }
}

test('void: body lost after the headers; GET shows VOIDED; settled by GET with zero new POST', async () => {
  const d = duble(); const m = await ate('CHECKED', d);
  d.rotas['POST /v2/payments/authorizations/A1/void'] = corpoFalha(200);
  await m.anular('P1', { humano: true });
  d.rotas['GET /v2/payments/authorizations/A1'] = json(200, { ...AUT, status: 'VOIDED' });
  await m.reconciliar('P1');
  assert.equal(m.pedido('P1').estado, 'VOIDED'); assert.equal(d.posts.length, 3);
});

test('capture: body lost after the headers; GET authorization + GET capture settle it with zero new POST', async () => {
  const d = duble(); const m = await ate('CHECKED', d);
  d.rotas['POST /v2/payments/authorizations/A1/capture'] = corpoTrava(201);
  await m.capturar('P1', { humano: true });
  d.rotas['GET /v2/payments/authorizations/A1'] = json(200, { ...AUT, status: 'CAPTURED', supplementary_data: { related_ids: { capture_id: 'K1' } } });
  d.rotas['GET /v2/payments/captures/K1'] = json(200, { id: 'K1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '50.00' }, supplementary_data: { related_ids: { authorization_id: 'A1' } } });
  await m.reconciliar('P1');
  assert.deepEqual([m.pedido('P1').estado, m.pedido('P1').capture_id], ['CAPTURED', 'K1']);
  assert.equal(d.posts.filter((x) => x.chave.endsWith('/capture')).length, 1);
});

test('malformed or incomplete 2xx capture answers are UNCERTAIN, never CAPTURED and never DECLINED', async () => {
  const casos = {
    'non-JSON body': json(201, '<html>gateway</html>'), 'truncated JSON': json(201, '{"id":"K1","status":'), 'JSON array': json(201, '[]'),
    'JSON null': json(201, 'null'), 'empty 200': vazio(200), 'empty object': json(201, {}), 'no status': json(201, { id: 'K1' }),
    'no id': json(201, { status: 'COMPLETED' }), 'unknown status': json(201, { id: 'K1', status: 'WEIRD' }),
    'other amount': json(201, { id: 'K1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '5.00' } }),
    'other authorization': json(201, { id: 'K1', status: 'COMPLETED', supplementary_data: { related_ids: { authorization_id: 'A9' } } }),
  };
  for (const [nome, resposta] of Object.entries(casos)) {
    const d = duble(); const m = await ate('CHECKED', d);
    d.rotas['POST /v2/payments/authorizations/A1/capture'] = resposta;
    await m.capturar('P1', { humano: true });
    const p = m.pedido('P1');
    assert.deepEqual([p.estado, p.incerto], ['UNCERTAIN', 'capture'], nome);
    assert.equal(p.contadores.capturas_ok, 0, nome);
    assert.equal(await tentarTudo(m, d), 0, nome);
  }
});

test('2xx authorize and create answers without identity or status are UNCERTAIN, not success', async () => {
  const auts = {
    'no authorizations': json(201, { id: 'O1', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [] } }] }),
    'two authorizations': json(201, { id: 'O1', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [AUT, { ...AUT, id: 'A2' }] } }] }),
    'authorization without status': json(201, { id: 'O1', purchase_units: [{ payments: { authorizations: [{ id: 'A1' }] } }] }),
    'empty 200': vazio(200), 'non-JSON': json(201, 'OK'),
  };
  for (const [nome, resposta] of Object.entries(auts)) {
    const d = duble({ 'POST /v2/checkout/orders/O1/authorize': resposta }); const m = await ate('CREATED', d);
    await m.autorizar('P1');
    assert.deepEqual([m.pedido('P1').estado, m.pedido('P1').incerto], ['UNCERTAIN', 'authorize'], nome);
    assert.equal(m.pedido('P1').autorizacao_id, undefined, nome);
  }
  for (const [nome, resposta] of Object.entries({ 'empty object': json(201, {}), 'no status': json(201, { id: 'O1' }), 'empty 201': vazio(201) })) {
    const d = duble({ 'POST /v2/checkout/orders': resposta });
    const m = new Mesa({ paypal: d.rest, brief: B0, amostra: AMOSTRA }); await m.criar({ id: 'P1' });
    assert.deepEqual([m.pedido('P1').estado, m.pedido('P1').incerto], ['UNCERTAIN', 'create'], nome);
  }
});

test('void answers: 204 empty and 200 VOIDED are valid; 200 empty and a non-VOIDED representation are UNCERTAIN', async () => {
  const casos = [['204 empty', vazio(204), 'VOIDED'], ['200 VOIDED', json(200, { ...AUT, status: 'VOIDED' }), 'VOIDED'], ['200 empty', vazio(200), 'UNCERTAIN'], ['200 CREATED', json(200, AUT), 'UNCERTAIN'], ['201 no status', json(201, { id: 'A1' }), 'UNCERTAIN']];
  for (const [nome, resposta, esperado] of casos) {
    const d = duble({ 'POST /v2/payments/authorizations/A1/void': resposta }); const m = await ate('CHECKED', d);
    await m.anular('P1', { humano: true });
    assert.equal(m.pedido('P1').estado, esperado, nome);
  }
});

test('only a complete 4xx is definitive: 422 reverts the void; 409, 408, 500 and a 4xx with a broken body stay UNCERTAIN', async () => {
  const d = duble({ 'POST /v2/payments/authorizations/A1/void': json(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'AUTHORIZATION_ALREADY_CAPTURED' }] }) });
  const m = await ate('CHECKED', d); await m.anular('P1', { humano: true });
  assert.equal(m.pedido('P1').estado, 'CHECKED', 'definitive refusal');
  for (const [nome, resposta] of [['409', json(409, { name: 'CONFLICT' })], ['408', json(408, {})], ['500', json(500, { name: 'INTERNAL_SERVER_ERROR' })], ['422 broken body', corpoFalha(422)]]) {
    const d2 = duble({ 'POST /v2/payments/authorizations/A1/void': resposta }); const m2 = await ate('CHECKED', d2);
    await m2.anular('P1', { humano: true });
    assert.deepEqual([m2.pedido('P1').estado, m2.pedido('P1').incerto], ['UNCERTAIN', 'void'], nome);
  }
});

test('the timeout covers headers and body, and no timer is left behind', async () => {
  const d = duble({ 'GET /v2/payments/authorizations/A1': corpoTrava(200) });
  const t0 = Date.now();
  await assert.rejects(d.rest.obterAutorizacao('A1'), (e) => e.incerto === true && /after HTTP 200 headers: AbortError/.test(e.message));
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(d.posts.every((x) => x.redirect === 'error'));
});
