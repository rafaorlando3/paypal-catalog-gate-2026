// C2/C2a: operation-specific UNCERTAIN states for every external call, zero new POST while UNCERTAIN, webhook matching,
// advisory budget, sandbox-only REST client and the cross-process store lock (with a real SIGKILL restart).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Mesa } from '../src/pedido.mjs';
import { PayPalFixture } from '../src/paypal-fixture.mjs';
import { StoreMemoria, StoreArquivo } from '../src/store.mjs';
import { PayPalRest, SANDBOX_ORIGIN } from '../src/paypal-rest.mjs';
import { B0 } from '../src/brief.mjs';

const ler = (n) => readFileSync(new URL(`../fixtures/L0/${n}`, import.meta.url), 'utf8');
const AMOSTRA = ler('AMOSTRA-L0-linhas-2-11.csv');
const DIA = 86400000;
const nova = (pp, store, extra = {}) => new Mesa({ paypal: pp, brief: B0, amostra: AMOSTRA, store, ...extra });

/** Holds one PayPal method until released: the request has "left" but no answer came back yet. */
function pausar(pp, metodo) {
  let soltar; const portao = new Promise((r) => { soltar = r; });
  const orig = pp[metodo].bind(pp);
  pp[metodo] = async (...a) => { await portao; return orig(...a); };
  return () => { pp[metodo] = orig; soltar(); };
}
const espera = () => new Promise((r) => setTimeout(r, 5));

async function pronto(store, pp, lote = 'L0.csv', extra = {}) {
  const m = nova(pp, store, extra);
  await m.criar({ id: 'P1', valor: '50.00', moeda: 'USD' }); await m.autorizar('P1');
  m.entregar('P1', ler(lote)); m.conferir('P1');
  return m;
}

/**
 * Every human action that could send a POST, tried on an UNCERTAIN order, plus two reconciliations.
 * Returns how many new POSTs reached PayPal (must be 0). Rule C2a: no POST for an UNCERTAIN operation, ever.
 */
async function tentarTudo(m, pp, id = 'P1') {
  const antes = pp.chamadas.length;
  const ignora = (f) => f().catch(() => {});
  await ignora(() => m.criar({ id }));
  await ignora(() => m.autorizar(id));
  await ignora(() => m.capturar(id, { humano: true, li_rejeicoes: true }));
  await ignora(() => m.anular(id, { humano: true }));
  await ignora(() => m.reautorizar(id, { humano: true }));
  await ignora(() => m.repetirCaptura(id));
  await ignora(() => m.reconciliar(id)); await ignora(() => m.reconciliar(id));
  return pp.chamadas.length - antes;
}

test('no resend path exists: the engine has no resend method and the HTTP action is unknown', () => {
  assert.equal(typeof Mesa.prototype.reenviarIdempotente, 'undefined');
  assert.ok(!readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8').includes("'reenviar'"));
  assert.ok(!readFileSync(new URL('../web/app.js', import.meta.url), 'utf8').includes('reenviar'));
});

test('create: lost answer gives UNCERTAIN(create); GET cannot settle it; zero new POST, blocked for manual review', async () => {
  const pp = new PayPalFixture({ cortar: ['create'] }); const m = nova(pp, new StoreMemoria());
  await m.criar({ id: 'P1' });
  assert.deepEqual([m.pedido('P1').estado, m.pedido('P1').incerto], ['UNCERTAIN', 'create']);
  pp.o.cortar = [];
  assert.equal(await tentarTudo(m, pp), 0);
  assert.equal(pp.chamadas.filter((x) => x.op === 'create').length, 1);
  assert.match(m.pedido('P1').alertas.at(-1).msg, /no GET can settle it; blocked for manual review, nothing is sent/);
  assert.equal(m.pedido('P1').estado, 'UNCERTAIN');
});

test('authorize: restart in flight gives UNCERTAIN(authorize); GET order settles it without a second POST', async () => {
  const store = new StoreMemoria(); const pp = new PayPalFixture();
  const m1 = nova(pp, store); await m1.criar({ id: 'P1' });
  const soltar = pausar(pp, 'autorizarPedido');
  const voo = m1.autorizar('P1'); await espera();
  assert.equal(JSON.parse(store.dados).pedidos[0].estado, 'AUTHORIZE_REQUESTED', 'intent persisted before the request');
  const m2 = nova(pp, store);
  assert.deepEqual([m2.pedido('P1').estado, m2.pedido('P1').incerto], ['UNCERTAIN', 'authorize']);
  soltar(); await voo;
  assert.equal(await tentarTudo(m2, pp), 0, 'the reconciliations inside tentarTudo are GET only');
  assert.equal(m2.pedido('P1').estado, 'AUTHORIZED', 'GET order settled it');
  assert.equal(m2.pedido('P1').autorizacao_id, [...pp.aut.keys()][0]);
  assert.equal(pp.chamadas.filter((x) => x.op === 'authorize').length, 1);
});

test('authorize: if PayPal never got it, GET shows no authorization and the order stays blocked with zero new POST', async () => {
  const store = new StoreMemoria(); const pp = new PayPalFixture();
  const m1 = nova(pp, store); await m1.criar({ id: 'P1' });
  const orig = pp.autorizarPedido.bind(pp); pp.autorizarPedido = () => new Promise(() => {});
  m1.autorizar('P1'); await espera();
  const m2 = nova(pp, store); pp.autorizarPedido = orig;
  assert.equal(await tentarTudo(m2, pp), 0);
  assert.equal(m2.pedido('P1').estado, 'UNCERTAIN');
  assert.match(m2.pedido('P1').alertas.at(-1).msg, /0 authorizations; blocked for manual review, nothing is sent/);
});

test('void: lost answer gives UNCERTAIN(void); capture stays blocked; GET authorization confirms VOIDED', async () => {
  const pp = new PayPalFixture({ cortar: ['void'] }); const m = await pronto(new StoreMemoria(), pp);
  await m.anular('P1', { humano: true });
  assert.deepEqual([m.pedido('P1').estado, m.pedido('P1').incerto], ['UNCERTAIN', 'void']);
  pp.o.cortar = [];
  assert.equal(await tentarTudo(m, pp), 0);
  assert.equal(m.pedido('P1').estado, 'VOIDED');
  assert.equal(pp.posts.filter((x) => x.op === 'void').length, 1);
  assert.equal(pp.posts.filter((x) => x.op === 'capture').length, 0);
});

test('void: restart in flight and PayPal never got it: GET shows CREATED, the order stays UNCERTAIN, zero new POST', async () => {
  const store = new StoreMemoria(); const pp = new PayPalFixture();
  const m1 = await pronto(store, pp);
  const orig = pp.anular.bind(pp); pp.anular = () => new Promise(() => {}); // the request never reaches PayPal
  m1.anular('P1', { humano: true }); await espera();
  const m2 = nova(pp, store); pp.anular = orig;
  assert.deepEqual([m2.pedido('P1').estado, m2.pedido('P1').incerto], ['UNCERTAIN', 'void']);
  assert.equal(await tentarTudo(m2, pp), 0);
  assert.match(m2.pedido('P1').alertas.at(-1).msg, /void not confirmed: PayPal shows CREATED\. Blocked for manual review; nothing is sent\./);
  assert.equal(pp.posts.length, 0);
  assert.equal(m2.pedido('P1').estado, 'UNCERTAIN');
});

test('reauthorize: lost answer gives UNCERTAIN(reauthorize); no GET settles it; zero new POST', async () => {
  let t = Date.parse('2026-11-09T12:00:00Z');
  const pp = new PayPalFixture({ cortar: ['reauthorize'] }); const m = await pronto(new StoreMemoria(), pp, 'L0.csv', { agora: () => t });
  t += 4 * DIA;
  await m.reautorizar('P1', { humano: true });
  assert.deepEqual([m.pedido('P1').estado, m.pedido('P1').incerto], ['UNCERTAIN', 'reauthorize']);
  pp.o.cortar = [];
  assert.equal(await tentarTudo(m, pp), 0);
  assert.equal(pp.posts.filter((x) => x.op === 'reauthorize').length, 1);
  assert.equal(pp.posts.filter((x) => x.op === 'capture').length, 0);
  assert.equal(m.pedido('P1').estado, 'UNCERTAIN');
  assert.match(m.pedido('P1').alertas.at(-1).msg, /uncertain reauthorize: no GET can settle it/);
});

test('capture: lost answer without a verifiable link: every action tried, zero new POST', async () => {
  const pp = new PayPalFixture({ cortarResposta: true, semVinculo: true }); const m = await pronto(new StoreMemoria(), pp);
  await m.capturar('P1', { humano: true });
  assert.deepEqual([m.pedido('P1').estado, m.pedido('P1').incerto], ['UNCERTAIN', 'capture']);
  pp.o.cortar = [];
  assert.equal(await tentarTudo(m, pp), 0);
  assert.equal(pp.posts.length, 1);
  assert.equal(m.pedido('P1').estado, 'UNCERTAIN');
});

test('webhook matching: missing ids never match an order without an authorization id', async () => {
  const pp = new PayPalFixture(); const m = nova(pp, new StoreMemoria());
  await m.criar({ id: 'SEM' }); // CREATED, autorizacao_id undefined
  for (const resource of [{ id: 'K1', amount: { currency_code: 'USD', value: '50.00' } }, { id: 'K1', supplementary_data: { related_ids: { authorization_id: undefined } } }, { id: 'K1', supplementary_data: { related_ids: { authorization_id: '' } } }]) {
    const r = m.webhook({ id: `WH-${Math.random()}`, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource });
    assert.deepEqual(r, { aplicado: false, motivo: 'no authorization id in the event' });
  }
  assert.deepEqual(m.webhook({ id: 'WH-x', event_type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: {} }), { aplicado: false, motivo: 'no authorization id in the event' });
  assert.deepEqual(m.webhook({ id: 'WH-y', event_type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: { id: 'A-unknown' } }), { aplicado: false, motivo: 'unknown authorization' });
  assert.equal(m.pedido('SEM').estado, 'CREATED');
});

test('webhook with insufficient evidence marks the order for GET; it is not deduplicated, so a complete redelivery still applies', async () => {
  const pp = new PayPalFixture(); const m = await pronto(new StoreMemoria(), pp);
  const A = m.pedido('P1').autorizacao_id;
  const incompleto = { id: 'WH-5', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'K5', supplementary_data: { related_ids: { authorization_id: A } } } };
  assert.deepEqual(m.webhook(incompleto), { aplicado: false, motivo: 'insufficient evidence; reconcile by GET' });
  assert.equal(m.pedido('P1').precisa_get, true); assert.equal(m.pedido('P1').estado, 'CHECKED');
  const completo = { ...incompleto, resource: { ...incompleto.resource, amount: { currency_code: 'USD', value: '50.00' } } };
  assert.deepEqual(m.webhook(completo), { aplicado: true });
  assert.equal(m.pedido('P1').estado, 'CAPTURED');
});

test('webhook cannot move an uncertain void back to a live state', async () => {
  const pp = new PayPalFixture({ cortar: ['void'] }); const m = await pronto(new StoreMemoria(), pp);
  await m.anular('P1', { humano: true });
  const A = m.pedido('P1').autorizacao_id;
  assert.deepEqual(m.webhook({ id: 'WH-c', event_type: 'PAYMENT.AUTHORIZATION.CREATED', resource: { id: A } }), { aplicado: false, motivo: 'order uncertain; reconcile by GET' });
  assert.equal(m.pedido('P1').estado, 'UNCERTAIN');
  assert.deepEqual(m.webhook({ id: 'WH-v', event_type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: { id: A } }), { aplicado: true });
  assert.equal(m.pedido('P1').estado, 'VOIDED');
});

test('advisory budget: per order and per day, counted before the call, persisted across a restart', async () => {
  const store = new StoreMemoria(); const pp = new PayPalFixture(); let chamadas = 0;
  const gerar = async () => { chamadas++; return 'Line 3: sku is required.'; };
  const m1 = await pronto(store, pp, 'L0-V2.csv', { limiteParecer: { porPedido: 2, porDia: 3 } });
  await m1.parecer('P1', gerar); await m1.parecer('P1', gerar);
  assert.equal((await m1.parecer('P1', gerar)).motivo, 'advisory budget reached');
  assert.equal(chamadas, 2);
  const m2 = nova(pp, store, { limiteParecer: { porPedido: 5, porDia: 3 } });
  await m2.criar({ id: 'P2' }); await m2.autorizar('P2'); m2.entregar('P2', ler('L0-V2.csv')); m2.conferir('P2');
  await m2.parecer('P2', gerar);
  assert.equal((await m2.parecer('P2', gerar)).motivo, 'advisory budget reached', 'the daily count survived the restart');
  assert.equal(chamadas, 3);
});

test('PayPalRest: exact sandbox origin, no base override, no production switch, no redirects, safe path ids', async () => {
  const env = { PAYPAL_BASE: process.env.PAYPAL_BASE, PERMITIR_PRODUCAO: process.env.PERMITIR_PRODUCAO };
  try {
    assert.throws(() => new PayPalRest({ clientId: 'x', secret: 'y', base: 'https://api-m.paypal.com' }), /only https:\/\/api-m\.sandbox\.paypal\.com/);
    assert.throws(() => new PayPalRest({ clientId: 'x', secret: 'y', base: 'https://api-m.sandbox.paypal.com.evil.io' }), /only/);
    process.env.PERMITIR_PRODUCAO = 'sim'; process.env.PAYPAL_BASE = 'https://api-m.paypal.com';
    assert.throws(() => new PayPalRest({ clientId: 'x', secret: 'y' }), /only/);
    delete process.env.PAYPAL_BASE;
    const vistos = [];
    const fetchImpl = async (url, init) => {
      vistos.push({ url, redirect: init.redirect, auth: init.headers.authorization?.split(' ')[0] });
      const body = url.endsWith('/v1/oauth2/token') ? { access_token: 'T', expires_in: 3600 } : { id: 'A1', status: 'CREATED' };
      return { status: 200, text: async () => JSON.stringify(body) };
    };
    const c = new PayPalRest({ clientId: 'x', secret: 'y', fetchImpl });
    assert.equal(c.base, SANDBOX_ORIGIN);
    await c.obterAutorizacao('A1'); await c.obterPedido('O1');
    await c.capturar({ autorizacaoId: 'A1', payload: { final_capture: true }, requestId: 'r' });
    assert.ok(vistos.every((v) => v.url.startsWith(`${SANDBOX_ORIGIN}/`) && v.redirect === 'error'));
    assert.deepEqual(vistos.map((v) => v.auth), ['Basic', 'Bearer', 'Bearer', 'Bearer']);
    await assert.rejects(c.obterAutorizacao('../../v1/x'), /invalid PayPal resource id/);
    await assert.rejects(c.obterCaptura('https://evil.example/'), /invalid PayPal resource id/);
    // A redirect on the token call: the resource request is never sent (naoEnviado), never followed.
    const redir = new PayPalRest({ clientId: 'x', secret: 'y', fetchImpl: async () => { throw new TypeError('fetch failed: redirect mode is set to error'); } });
    await assert.rejects(redir.obterAutorizacao('A1'), (e) => e.naoEnviado === true && !e.incerto);
    // A redirect on the resource request itself: it may have been processed, so it is uncertain.
    const redir2 = new PayPalRest({ clientId: 'x', secret: 'y', fetchImpl: async (url) => { if (url.endsWith('/v1/oauth2/token')) return { status: 200, text: async () => '{"access_token":"T","expires_in":3600}' }; throw new TypeError('fetch failed: redirect mode is set to error'); } });
    await assert.rejects(redir2.anular({ autorizacaoId: 'A1', requestId: 'r' }), (e) => e.incerto === true);
  } finally {
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('file store lock: a second writer in this process fails; a lock from a valid, proven-dead pid is taken over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-lock-'));
  try {
    const caminho = join(dir, 'orders.json');
    const a = new StoreArquivo(caminho);
    assert.throws(() => new StoreArquivo(caminho), (e) => e.codigo === 'STORE_LOCKED');
    a.soltar();
    const b = new StoreArquivo(caminho); b.soltar();
    const morto = spawnSync(process.execPath, ['-e', '0']).pid; // a real process that has already exited
    for (const pid of [String(morto), '2147483646']) {
      writeFileSync(`${caminho}.lock`, pid);
      const c = new StoreArquivo(caminho);
      assert.equal(readFileSync(`${caminho}.lock`, 'utf8'), String(process.pid), `dead pid ${pid} taken over`); c.soltar();
      assert.equal(existsSync(`${caminho}.lock`), false);
    }
    assert.deepEqual(readdirSync(dir), [], 'no temp lock files left behind');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('file store lock is fail-closed: empty, invalid or ambiguous pid content keeps STORE_LOCKED and the file is not removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-lock-'));
  try {
    const caminho = join(dir, 'orders.json');
    for (const conteudo of ['', ' ', 'abc', '0', '-5', '1.5', '12 34', ' 123', '123\n', '0123', '1e3', '2147483648', '99999999999', String(process.pid) + 'x']) {
      writeFileSync(`${caminho}.lock`, conteudo);
      assert.throws(() => new StoreArquivo(caminho), (e) => e.codigo === 'STORE_LOCKED' && /without a valid pid/.test(e.message), JSON.stringify(conteudo));
      assert.equal(readFileSync(`${caminho}.lock`, 'utf8'), conteudo, `lock ${JSON.stringify(conteudo)} left untouched`);
    }
    writeFileSync(`${caminho}.lock`, String(process.pid)); // valid and alive
    assert.throws(() => new StoreArquivo(caminho), (e) => e.codigo === 'STORE_LOCKED' && /by process/.test(e.message));
    assert.equal(readFileSync(`${caminho}.lock`, 'utf8'), String(process.pid));
    assert.deepEqual(readdirSync(dir).sort(), ['orders.json.lock'], 'no temp lock files left behind');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A real second process: it locks the store, starts a capture that never gets an answer, and is killed with SIGKILL.
const FILHO = `
import { StoreArquivo } from './src/store.mjs';
import { Mesa } from './src/pedido.mjs';
import { PayPalFixture } from './src/paypal-fixture.mjs';
import { B0 } from './src/brief.mjs';
import { readFileSync } from 'node:fs';
const ler = (n) => readFileSync('./fixtures/L0/' + n, 'utf8');
const pp = new PayPalFixture(); pp.capturar = () => new Promise(() => {});
const m = new Mesa({ paypal: pp, brief: B0, amostra: ler('AMOSTRA-L0-linhas-2-11.csv'), store: new StoreArquivo(process.argv[1]) });
await m.criar({ id: 'P1' }); await m.autorizar('P1'); m.entregar('P1', ler('L0.csv')); m.conferir('P1');
m.capturar('P1', { humano: true });
setTimeout(() => console.log('IN_FLIGHT'), 20); setInterval(() => {}, 1000);
`;

test('real restart across processes: SIGKILL during a capture; the next process takes the stale lock, sees UNCERTAIN(capture) and sends nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-proc-'));
  const caminho = join(dir, 'orders.json');
  const filho = spawn(process.execPath, ['--input-type=module', '-e', FILHO, caminho], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((ok, falha) => { filho.stdout.on('data', (d) => { if (String(d).includes('IN_FLIGHT')) ok(); }); filho.on('exit', (c) => falha(new Error(`child exited ${c}`))); });
    assert.throws(() => new StoreArquivo(caminho), (e) => e.codigo === 'STORE_LOCKED', 'while the first process lives, a second writer is refused');
    filho.kill('SIGKILL'); await new Promise((r) => filho.once('exit', r));
    const store = new StoreArquivo(caminho);
    const pp = new PayPalFixture();
    const m = nova(pp, store);
    assert.deepEqual([m.pedido('P1').estado, m.pedido('P1').incerto], ['UNCERTAIN', 'capture']);
    assert.match(m.pedido('P1').alertas.at(-1).msg, /Restart while a capture request was in flight/);
    assert.equal(await tentarTudo(m, pp), 0);
    assert.equal(pp.posts.length, 0);
    store.soltar();
  } finally { filho.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('fixed template explanation of each defective lot passes the checker; a canned off-report citation is rejected', async () => {
  const { validar } = await import('../src/validar.mjs');
  const { explicacaoFixa, checarParecer, linhasCitadas } = await import('../src/parecer.mjs');
  const esperado = { 'L0-V2.csv': [46, 121, 178], 'L0-V4.csv': [1], 'L0-V5.csv': [43, 151], 'L0-V6.csv': [6] };
  for (const [lote, linhas] of Object.entries(esperado)) {
    const rel = validar(B0, ler(lote), AMOSTRA);
    const t = explicacaoFixa(rel);
    assert.deepEqual(linhasCitadas(t), linhas, lote);
    assert.deepEqual(checarParecer(t, rel), { ok: true }, lote);
    assert.match(checarParecer(`${t} Line 47 also looks odd.`, rel).motivo, /no finding|does not exist/);
  }
});


// Final advisory qualification: mocked HTTP only; never a provider key or network call.
test('Gemini advisory: fixed model and origin, no redirects, bounded output and stable errors', async () => {
  const { geradorGemini } = await import('../src/parecer.mjs');
  const { validar } = await import('../src/validar.mjs');
  const rel = validar(B0, ler('L0-V2.csv'), AMOSTRA);
  const chave = 'SYNTHETIC-ADVISORY-CANARY-DO-NOT-LEAK';
  let chamadas = 0;
  const resposta = (texto) => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: texto }] } }] }));
  const gerar = geradorGemini({ chave, fetchImpl: async (url, init) => {
    chamadas++;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['x-goog-api-key'], chave);
    assert.ok(!init.body.includes(chave));
    const body = JSON.parse(init.body);
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
    assert.equal(body.generationConfig.maxOutputTokens, 2048);
    assert.equal(Object.hasOwn(body.generationConfig, 'temperature'), false);
    return resposta('Lines 46, 121 and 178 have missing prices.');
  } });
  assert.equal(await gerar(rel, B0), 'Lines 46, 121 and 178 have missing prices.');
  assert.equal(chamadas, 1);
  assert.throws(() => geradorGemini({ chave, modelo: '../escape', fetchImpl: () => { chamadas++; } }), /Unsupported advisory model/);
  assert.equal(chamadas, 1, 'invalid model never reaches a transport');
  const testar = async (fetchImpl, codigo, extra = {}) => {
    const g = geradorGemini({ chave, fetchImpl, ...extra });
    await assert.rejects(g(rel, B0), (e) => e.codigo === codigo && !e.message.includes(chave) && !e.stack.includes(chave));
  };
  await testar(async () => { throw new TypeError(`redirect failed with ${chave}`); }, 'advisory_unavailable');
  await testar(async () => new Response(chave, { status: 429 }), 'advisory_http');
  await testar(async () => new Response(chave.repeat(2000)), 'advisory_too_large');
  await testar(async () => resposta('x'.repeat(8193)), 'advisory_too_large');
  await testar(async () => new Response(`invalid JSON ${chave}`), 'advisory_invalid');
  await testar(async () => new Response('{"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":123}]}}]}'), 'advisory_invalid');
  await testar(async () => new Response('{"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[{"text":"Line 46 has missing price."}]}}]}'), 'advisory_invalid');
  const semPensamento = geradorGemini({ chave, fetchImpl: async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'private reasoning summary' }, { thoughtSignature: 'opaque-test-signature' }, { text: 'Line 46 has missing price.' }] } }] })) });
  assert.equal(await semPensamento(rel, B0), 'Line 46 has missing price.');
  await testar(async (_url, init) => new Response(new ReadableStream({
    start(controller) { init.signal.addEventListener('abort', () => controller.error(new Error(chave)), { once: true }); },
  })), 'advisory_timeout', { timeoutMs: 10 });
});

test('frozen advisory facts match actual deterministic report findings', async () => {
  const { validar } = await import('../src/validar.mjs');
  const { createHash } = await import('node:crypto');
  const facts = JSON.parse(ler('AI-EXPECTED-FACTS-20261111.json'));
  assert.deepEqual(facts.lots.map((x) => x.file), ['L0-V2.csv', 'L0-V5.csv', 'L0-V6.csv']);
  assert.equal(createHash('sha256').update(ler(facts.approved_sample.file)).digest('hex'), facts.approved_sample.sha256);
  const reports = facts.lots.map((x) => {
    const csv = ler(x.file);
    assert.equal(createHash('sha256').update(csv).digest('hex'), x.sha256);
    const r = validar(B0, csv, AMOSTRA);
    const lines = [...new Set([...r.rejeicoes.map((z) => z.linha), ...r.duplicatas.flatMap((z) => z.linhas), ...r.amostra.filter((z) => !z.confere).map((z) => z.linha)])].sort((a,b) => a-b);
    assert.deepEqual(lines, x.expected_finding_lines);
    return r;
  });
  assert.equal(reports[0].rejeicoes.length, 3);
  assert.ok(reports[0].rejeicoes.every((x) => x.campo === 'precio'));
  assert.equal(reports[1].duplicatas.length, 1);
  assert.equal(reports[1].duplicatas[0].chave, 'ABC-0042');
  assert.deepEqual(reports[2].amostra.filter((x) => !x.confere).map((x) => [x.linha,x.campo,x.recebido,x.esperado]), [[6,'precio','2.58','2.85']]);
});
