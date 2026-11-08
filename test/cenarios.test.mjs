// The 19 scenarios of R1 v3 (CENARIOS.md), all in fixture mode: no PayPal receipt is produced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Mesa, ErroRegra } from '../src/pedido.mjs';
import { PayPalFixture } from '../src/paypal-fixture.mjs';
import { B0 } from '../src/brief.mjs';

const DIA = 86400000;
const ler = (n) => readFileSync(new URL(`../fixtures/L0/${n}`, import.meta.url), 'utf8');
const SHA = {
  'L0.csv': '40aa76c1fc943bba3bdfaf8ba1423fb8b2aaf7726bba4b8b76d1a9faaa77dc28',
  'L0-V2.csv': '1fefd62a51f476b5c76b7eb3c5c36023e350eb86d4082016a086a0c7fc22ba14',
  'L0-V4.csv': '20fb4571816ca2ef0f20d93fd9192226e9f6418a9edc76f743c550766edccc8d',
  'L0-V5.csv': '31c63afc5064ac9d98329e6551efedc2af3ed2b5e5d095fc70c1e763185e33ff',
  'L0-V6.csv': 'c71bbfad3c5111d6e683bf0d90d20679528f723d2181f2c334a578a48ed16783',
  'AMOSTRA-L0-linhas-2-11.csv': '50311920c0097d8017bf2741fa96cdc5775f6ef263a432aafd37c926e7012ae9',
};
const lote = (n) => { const t = ler(n); assert.equal(createHash('sha256').update(t).digest('hex'), SHA[n], `hash do lote ${n}`); return t; };

async function montar(arquivo = 'L0.csv', opcoes = {}) {
  let t = Date.parse('2026-11-09T12:00:00Z');
  const relogio = { agora: () => t, avancarDias: (d) => { t += d * DIA; } };
  const pp = new PayPalFixture(opcoes);
  const mesa = new Mesa({ paypal: pp, agora: relogio.agora, brief: B0, amostra: lote('AMOSTRA-L0-linhas-2-11.csv') });
  await mesa.criar({ id: 'P0', valor: '50.00', moeda: 'USD' });
  await mesa.autorizar('P0');
  if (arquivo) { mesa.entregar('P0', lote(arquivo)); mesa.conferir('P0'); }
  return { mesa, pp, relogio, p: () => mesa.pedido('P0') };
}

test('V1 verde: um clique humano gera 1 captura integral', async () => {
  const { mesa, pp, p } = await montar('L0.csv');
  const r = p().relatorio;
  assert.equal(r.lote_sha256, SHA['L0.csv']);
  assert.deepEqual([r.lidas, r.validas, r.rejeicoes.length, r.duplicatas.length, r.amostra.filter((a) => a.confere).length, r.veredito], [200, 200, 0, 0, 10, 'verde']);
  await assert.rejects(mesa.capturar('P0'), (e) => e.codigo === 'NO_HUMAN_CLICK');
  await mesa.capturar('P0', { humano: true });
  assert.equal(p().estado, 'CAPTURED');
  assert.equal(pp.posts[0].payload.final_capture, true);
  assert.deepEqual(pp.posts[0].payload.amount, { currency_code: 'USD', value: '50.00' }, 'full authorized amount, stated explicitly');
  assert.deepEqual([p().contadores.posts_capture, p().contadores.capturas_ok], [1, 1]);
});

test('V2 amarelo aceito: exige "li as 3 rejeições"', async () => {
  const { mesa, p } = await montar('L0-V2.csv');
  assert.deepEqual(p().relatorio.rejeicoes, [{ linha: 46, campo: 'precio', motivo: 'required' }, { linha: 121, campo: 'precio', motivo: 'required' }, { linha: 178, campo: 'precio', motivo: 'required' }]);
  assert.equal(p().relatorio.validas, 197); assert.equal(p().cor, 'amarelo');
  await mesa.capturar('P0', { humano: true });
  assert.equal(p().contadores.posts_capture, 0, 'sem a caixa marcada não envia');
  await mesa.capturar('P0', { humano: true, li_rejeicoes: true });
  assert.equal(p().estado, 'CAPTURED'); assert.equal(p().contadores.posts_capture, 1);
});

test('V3 amarelo recusado: reentrega, 0 POST', async () => {
  const { mesa, p } = await montar('L0-V2.csv');
  mesa.pedirReentrega('P0');
  assert.equal(p().estado, 'REDELIVERY'); assert.equal(p().reentregas, 1); assert.equal(p().contadores.posts_capture, 0);
  mesa.entregar('P0', lote('L0.csv'));
  assert.equal(p().estado, 'DELIVERED');
});

test('V4 vermelho cabeçalho: corpo não avaliado', async () => {
  const { mesa, p } = await montar('L0-V4.csv');
  assert.deepEqual(p().relatorio.rejeicoes, [{ linha: 1, campo: 'precioo', motivo: 'header' }]);
  assert.equal(p().relatorio.lidas, 0); assert.equal(p().cor, 'vermelho');
  await mesa.capturar('P0', { humano: true, li_rejeicoes: true });
  assert.equal(p().contadores.posts_capture, 0);
});

test('V5 vermelho duplicata mesmo com 200 válidas', async () => {
  const { mesa, p } = await montar('L0-V5.csv');
  assert.deepEqual(p().relatorio.duplicatas, [{ chave: 'ABC-0042', linhas: [43, 151] }]);
  assert.equal(p().relatorio.validas, 200); assert.equal(p().cor, 'vermelho');
  await mesa.capturar('P0', { humano: true });
  assert.equal(p().contadores.posts_capture, 0);
});

test('V6 vermelho amostra: linha 6 esperado 2.85 recebido 2.58', async () => {
  const { mesa, p } = await montar('L0-V6.csv');
  const a = p().relatorio.amostra;
  assert.deepEqual(a.find((x) => !x.confere), { linha: 6, confere: false, campo: 'precio', esperado: '2.85', recebido: '2.58' });
  assert.equal(a.filter((x) => x.confere).length, 9); assert.equal(p().cor, 'vermelho');
  await mesa.capturar('P0', { humano: true });
  assert.equal(p().contadores.posts_capture, 0);
});

test('F1 clique duplo: 1 POST; fixture devolve o mesmo capture_id para o mesmo Request-Id', async () => {
  const { mesa, pp, p } = await montar('L0.csv', { atrasoMs: 50 });
  const a = mesa.capturar('P0', { humano: true });
  await new Promise((r) => setTimeout(r, 10));
  const b = mesa.capturar('P0', { humano: true });
  await Promise.all([a, b]);
  assert.equal(pp.posts.length, 1); assert.equal(p().contadores.posts_capture, 1); assert.equal(p().contadores.capturas_ok, 1);
  // Lock off: same id sent twice straight to the fixture returns the latest state of the first request.
  const { requestId, autorizacaoId, payload } = pp.posts[0];
  const de_novo = await pp.capturar({ autorizacaoId, payload, requestId });
  assert.equal(de_novo.id, p().capture_id);
});

test('F2a resposta perdida com vínculo suficiente: CAPTURADO só depois dos GETs', async () => {
  const { mesa, p } = await montar('L0.csv', { cortarResposta: true });
  await mesa.capturar('P0', { humano: true });
  assert.equal(p().estado, 'UNCERTAIN'); assert.equal(p().incerto, 'capture');
  await mesa.reconciliar('P0');
  assert.equal(p().estado, 'CAPTURED'); assert.ok(p().capture_id);
  assert.equal(p().contadores.posts_capture, 1);
});

test('F2b resposta perdida sem vínculo: segue INCERTO, alerta, zero novo POST', async () => {
  const { mesa, pp, p } = await montar('L0.csv', { cortarResposta: true, semVinculo: true });
  await mesa.capturar('P0', { humano: true });
  await mesa.reconciliar('P0');
  assert.equal(p().estado, 'UNCERTAIN');
  assert.match(p().alertas.at(-1).msg, /without a verifiable link/);
  await mesa.capturar('P0', { humano: true });
  await mesa.anular('P0', { humano: true });
  await mesa.reautorizar('P0', { humano: true });
  await assert.rejects(mesa.repetirCaptura('P0'), (e) => e.codigo === 'CAPTURE_BLOCKED');
  assert.equal(pp.posts.length, 1); assert.equal(p().contadores.capturas_ok, 0);
});

test('F3 simultâneas: no máximo 1 POST em voo', async () => {
  const { mesa, pp, p } = await montar('L0.csv', { atrasoMs: 30 });
  await Promise.all([mesa.capturar('P0', { humano: true }), mesa.capturar('P0', { humano: true })]);
  assert.equal(pp.posts.length, 1); assert.equal(p().estado, 'CAPTURED');
});

test('F4 mesmo Request-Id com payload diferente: bloqueio local, zero envio', async () => {
  const { mesa, pp, p } = await montar('L0.csv', { cortarResposta: true });
  await mesa.capturar('P0', { humano: true });
  await assert.rejects(mesa.repetirCaptura('P0', { final_capture: true, amount: { currency_code: 'USD', value: '45.00' } }), (e) => e.codigo === 'REQUEST_ID_PAYLOAD_MISMATCH');
  assert.equal(p().estado, 'UNCERTAIN'); assert.equal(pp.posts.length, 1); assert.equal(p().contadores.posts_capture, 1);
  assert.match(p().alertas.at(-1).msg, /different payload/);
});

test('F5 divergência local x PayPal: INCERTO(divergencia), 0 POST', async () => {
  const { mesa, pp, p } = await montar(null, { autStatus: 'VOIDED' });
  await mesa.reconciliar('P0');
  assert.equal(p().estado, 'UNCERTAIN'); assert.deepEqual(p().divergencia, { local: 'AUTHORIZED', paypal: 'VOIDED' });
  await mesa.anular('P0', { humano: true });
  assert.equal(pp.posts.length, 0);
});

test('F6 webhook duplicado e fora de ordem: só para frente', async () => {
  const { mesa, p } = await montar('L0.csv');
  const A1 = p().autorizacao_id;
  const E2 = { id: 'WH-2', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'K9', status: 'COMPLETED', supplementary_data: { related_ids: { authorization_id: A1 } } } };
  const E1 = { id: 'WH-1', event_type: 'PAYMENT.AUTHORIZATION.CREATED', resource: { id: A1 } };
  assert.equal(mesa.webhook(E2).aplicado, true);
  assert.deepEqual(mesa.webhook(E1), { aplicado: false, motivo: 'backwards' });
  assert.deepEqual(mesa.webhook(E2), { aplicado: false, motivo: 'duplicate' });
  assert.equal(p().estado, 'CAPTURED');
});

test('F7 captura recusada: sem retry automático', async () => {
  const { mesa, p } = await montar('L0.csv', { captura: 'DECLINED' });
  await mesa.capturar('P0', { humano: true });
  assert.equal(p().estado, 'CAPTURE_DECLINED'); assert.equal(p().contadores.posts_capture, 1); assert.equal(p().contadores.capturas_ok, 0);
  await mesa.capturar('P0', { humano: true });
  assert.equal(p().contadores.posts_capture, 1);
});

test('F8 void depois de captura: bloqueado, 0 POST void', async () => {
  const { mesa, p } = await montar('L0.csv');
  await mesa.capturar('P0', { humano: true });
  await mesa.anular('P0', { humano: true });
  assert.equal(p().estado, 'CAPTURED'); assert.equal(p().contadores.posts_void, 0);
});

test('H1 honor period vencido: aviso; reautorização só humana e uma vez', async () => {
  const { mesa, pp, p, relogio } = await montar(null);
  mesa.entregar('P0', lote('L0.csv'));
  relogio.avancarDias(2);
  await mesa.reautorizar('P0', { humano: true });
  assert.equal(p().contadores.posts_reauth, 0, 'dia 2: bloqueado');
  relogio.avancarDias(3); // dia 5
  assert.match(mesa.avisos('P0')[0], /Honor period over/);
  assert.equal(pp.posts.length, 0);
  const A1 = p().autorizacao_id;
  await mesa.reautorizar('P0', { humano: true });
  assert.notEqual(p().autorizacao_id, A1); assert.deepEqual(p().autorizacoes_substituidas, [A1]);
  await mesa.reautorizar('P0', { humano: true });
  assert.equal(p().contadores.posts_reauth, 1);
});

test('H2 autorização expirada no dia 30: nada habilitado', async () => {
  const { mesa, pp, p, relogio } = await montar('L0.csv');
  relogio.avancarDias(30);
  assert.equal(p().estado, 'EXPIRED');
  await mesa.capturar('P0', { humano: true });
  await mesa.reautorizar('P0', { humano: true });
  assert.equal(pp.posts.length, 0);
  assert.match(mesa.avisos('P0')[0], /new order/);
});

test('I1 parecer cita linha inexistente: rejeitado, veredito inalterado', async () => {
  const { mesa, p } = await montar('L0-V2.csv');
  const par = await mesa.parecer('P0', async () => 'Line 250 has an empty price.');
  assert.equal(par.estado, 'rejected'); assert.match(par.motivo, /250/);
  assert.equal(p().cor, 'amarelo');
  const bom = await mesa.parecer('P0', async () => 'Lines 46, 121 and 178 have an empty price.');
  assert.equal(bom.estado, 'accepted');
});

test('I2 modelo fora: parecer indisponível, captura como em V1', async () => {
  const { mesa, p } = await montar('L0.csv');
  const par = await mesa.parecer('P0', async () => { throw new Error('model down'); });
  assert.equal(par.estado, 'unavailable');
  await mesa.capturar('P0', { humano: true });
  assert.equal(p().estado, 'CAPTURED');
});

test('C19a captura pendente que conclui: só por GET', async () => {
  const { mesa, pp, p } = await montar('L0.csv', { captura: 'PENDING' });
  await mesa.capturar('P0', { humano: true });
  assert.equal(p().estado, 'CAPTURE_PENDING'); assert.equal(p().contadores.capturas_ok, 0);
  await mesa.capturar('P0', { humano: true });
  await mesa.anular('P0', { humano: true });
  pp.o.capturaGet = 'COMPLETED';
  await mesa.reconciliar('P0');
  assert.equal(p().estado, 'CAPTURED'); assert.equal(p().contadores.capturas_ok, 1); assert.equal(p().contadores.posts_capture, 1);
});

for (const st of ['DECLINED', 'FAILED']) {
  test(`C19b captura pendente que falha (${st}): sem recaptura`, async () => {
    const { mesa, pp, p } = await montar('L0.csv', { captura: 'PENDING' });
    await mesa.capturar('P0', { humano: true });
    pp.o.capturaGet = st;
    await mesa.reconciliar('P0');
    assert.equal(p().estado, 'CAPTURE_DECLINED'); assert.equal(p().contadores.posts_capture, 1); assert.equal(p().contadores.capturas_ok, 0);
  });
}

test('ErroRegra é exportado', () => assert.ok(new ErroRegra('X', 'y') instanceof Error));
