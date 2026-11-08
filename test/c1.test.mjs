// C1: persistence and recovery, idempotency across restarts, webhook signature and deduplication.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign, generateKeyPairSync } from 'node:crypto';
import { Mesa, requestIdDe } from '../src/pedido.mjs';
import { PayPalFixture } from '../src/paypal-fixture.mjs';
import { StoreMemoria, StoreArquivo } from '../src/store.mjs';
import { criarVerificador, mensagemAssinada, certUrlPermitida } from '../src/webhook.mjs';
import { B0 } from '../src/brief.mjs';

const ler = (n) => readFileSync(new URL(`../fixtures/L0/${n}`, import.meta.url), 'utf8');
const AMOSTRA = ler('AMOSTRA-L0-linhas-2-11.csv');
// A throwaway RSA key pair made at test time; no key material is stored in the repository.
const { publicKey: PUB, privateKey: KEY } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CERT = PUB.export({ type: 'spki', format: 'pem' });

async function preparar(store, pp, lote = 'L0.csv') {
  const mesa = new Mesa({ paypal: pp, brief: B0, amostra: AMOSTRA, store });
  await mesa.criar({ id: 'P1', valor: '50.00', moeda: 'USD' });
  await mesa.autorizar('P1');
  mesa.entregar('P1', ler(lote)); mesa.conferir('P1');
  return mesa;
}

test('PayPal-Request-Id is deterministic, UUID-shaped and within 38 characters', () => {
  const a = requestIdDe('P1', 'capture', 'A2'), b = requestIdDe('P1', 'capture', 'A2'), c = requestIdDe('P1', 'void', 'A2');
  assert.equal(a, b); assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(a.length <= 38);
});

test('restart restores every order with its report and counters', async () => {
  const store = new StoreMemoria(); const pp = new PayPalFixture();
  const m1 = await preparar(store, pp, 'L0-V2.csv');
  const m2 = new Mesa({ paypal: pp, brief: B0, amostra: AMOSTRA, store });
  const p = m2.pedido('P1');
  assert.equal(p.estado, 'CHECKED'); assert.equal(p.cor, 'amarelo'); assert.equal(p.relatorio.rejeicoes.length, 3);
  assert.equal(p.autorizacao_id, m1.pedido('P1').autorizacao_id);
  await m2.capturar('P1', { humano: true, li_rejeicoes: true });
  assert.equal(m2.pedido('P1').estado, 'CAPTURED');
});

test('restart while a capture is in flight: UNCERTAIN, then GET reconciliation, never a second POST', async () => {
  const store = new StoreMemoria(); const pp = new PayPalFixture({ atrasoMs: 40 });
  const m1 = await preparar(store, pp);
  const voo = m1.capturar('P1', { humano: true });
  await new Promise((r) => setTimeout(r, 10));
  const m2 = new Mesa({ paypal: pp, brief: B0, amostra: AMOSTRA, store }); // the "new process"
  assert.equal(m2.pedido('P1').estado, 'UNCERTAIN');
  assert.match(m2.pedido('P1').alertas.at(-1).msg, /Restart while a capture was in flight/);
  await voo; // PayPal (fixture) did complete the first request
  await m2.capturar('P1', { humano: true });
  await m2.reconciliar('P1');
  assert.equal(m2.pedido('P1').estado, 'CAPTURED');
  assert.equal(pp.posts.filter((x) => x.op === 'capture').length, 1);
});

test('request id and payload hash survive a restart: a divergent retry is blocked before sending', async () => {
  const store = new StoreMemoria(); const pp = new PayPalFixture({ cortarResposta: true });
  const m1 = await preparar(store, pp);
  await m1.capturar('P1', { humano: true });
  const m2 = new Mesa({ paypal: pp, brief: B0, amostra: AMOSTRA, store });
  await assert.rejects(m2.repetirCaptura('P1', { amount: { currency_code: 'USD', value: '45.00' }, final_capture: true }), (e) => e.codigo === 'REQUEST_ID_PAYLOAD_MISMATCH');
  await assert.rejects(m2.repetirCaptura('P1'), (e) => e.codigo === 'CAPTURE_BLOCKED');
  assert.equal(pp.posts.length, 1);
});

test('webhook deduplication survives a restart', async () => {
  const store = new StoreMemoria(); const pp = new PayPalFixture();
  const m1 = await preparar(store, pp);
  const A = m1.pedido('P1').autorizacao_id;
  const ev = { id: 'WH-77', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'K77', status: 'COMPLETED', amount: { currency_code: 'USD', value: '50.00' }, supplementary_data: { related_ids: { authorization_id: A } } } };
  assert.equal(m1.webhook(ev).aplicado, true);
  const m2 = new Mesa({ paypal: pp, brief: B0, amostra: AMOSTRA, store });
  assert.deepEqual(m2.webhook(ev), { aplicado: false, motivo: 'duplicate' });
  assert.equal(m2.pedido('P1').estado, 'CAPTURED');
});

test('webhook with a capture amount different from the order is not applied', async () => {
  const pp = new PayPalFixture(); const m = await preparar(new StoreMemoria(), pp);
  const A = m.pedido('P1').autorizacao_id;
  const r = m.webhook({ id: 'WH-9', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'K9', amount: { currency_code: 'USD', value: '5.00' }, supplementary_data: { related_ids: { authorization_id: A } } } });
  assert.deepEqual(r, { aplicado: false, motivo: 'amount mismatch' });
  assert.equal(m.pedido('P1').estado, 'CHECKED');
});

test('file store writes atomically and reads back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-'));
  try {
    const s = new StoreArquivo(join(dir, 'data', 'orders.json'));
    assert.equal(s.ler(), null);
    s.gravar({ versao: 1, pedidos: [{ id: 'X' }], eventos: ['E'] });
    assert.deepEqual(s.ler(), { versao: 1, pedidos: [{ id: 'X' }], eventos: ['E'] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Signature fixture: the throwaway key pair above, never a PayPal key.
function assinar(corpo, { webhookId = 'WH-ID-TEST', tempo = '2026-11-09T12:00:00Z', id = 'tx-1', certUrl = 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST' } = {}) {
  const msg = mensagemAssinada({ transmissionId: id, transmissionTime: tempo, webhookId, corpo });
  return { 'paypal-transmission-id': id, 'paypal-transmission-time': tempo, 'paypal-cert-url': certUrl, 'paypal-auth-algo': 'SHA256withRSA', 'paypal-transmission-sig': sign('sha256', Buffer.from(msg), KEY).toString('base64') };
}
const verificador = () => criarVerificador({ webhookId: 'WH-ID-TEST', buscarCert: async () => CERT, agora: () => Date.parse('2026-11-09T12:05:00Z') });

test('webhook signature: valid message is accepted', async () => {
  const corpo = JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED' });
  assert.deepEqual(await verificador()(assinar(corpo), corpo), { ok: true, transmissionId: 'tx-1' });
});

test('webhook signature: tampered body, wrong webhook id, foreign cert host, stale time and missing headers are rejected', async () => {
  const v = verificador();
  const corpo = JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED' });
  assert.equal((await v(assinar(corpo), corpo.replace('WH-1', 'WH-2'))).ok, false);
  assert.equal((await v(assinar(corpo, { webhookId: 'OTHER' }), corpo)).ok, false);
  assert.match((await v(assinar(corpo, { certUrl: 'https://evil.example/cert' }), corpo)).motivo, /paypal\.com/);
  assert.match((await v(assinar(corpo, { tempo: '2026-11-09T10:00:00Z' }), corpo)).motivo, /window/);
  assert.match((await v({}, corpo)).motivo, /missing/);
  assert.equal(certUrlPermitida('http://api.paypal.com/x'), false);
  assert.equal(certUrlPermitida('https://api.paypal.com.evil.io/x'), false);
});

test('every engine message is English', async () => {
  const pp = new PayPalFixture({ captura: 'PENDING' }); const m = await preparar(new StoreMemoria(), pp, 'L0-V5.csv');
  await m.capturar('P1', { humano: true });
  m.pedirReentrega('P1');
  const textos = [...m.log.map((l) => `${l.evento} ${l.motivo || ''} ${l.msg || ''}`), ...m.pedido('P1').relatorio.motivos];
  for (const t of textos) assert.doesNotMatch(t, /[ãçéíóúâêô]|pedido|captura|conferid|entregue/i, t);
});
