// HTTP demo server. MODE=fixture (default, no PayPal call, labeled) or MODE=sandbox (PayPal sandbox REST).
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Mesa, ErroRegra } from './pedido.mjs';
import { PayPalFixture } from './paypal-fixture.mjs';
import { PayPalRest } from './paypal-rest.mjs';
import { B0 } from './brief.mjs';
import { geradorGemini } from './parecer.mjs';
import { StoreArquivo } from './store.mjs';
import { criarVerificador, buscarCertHttps } from './webhook.mjs';

const RAIZ = new URL('..', import.meta.url);
const MODO = process.env.MODE === 'sandbox' ? 'sandbox' : 'fixture';
const PORTA = Number(process.env.PORT || 8787);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORTA}`;
const LOTES = Object.fromEntries(readdirSync(new URL('fixtures/L0/', RAIZ)).filter((n) => n.startsWith('L0')).map((n) => [n, readFileSync(new URL(`fixtures/L0/${n}`, RAIZ), 'utf8')]));
const AMOSTRA = readFileSync(new URL('fixtures/L0/AMOSTRA-L0-linhas-2-11.csv', RAIZ), 'utf8');
const MAX_LOTE = 200 * 1024;

const paypal = MODO === 'sandbox' ? new PayPalRest({ retornoUrl: `${BASE_URL}/retorno` }) : null;
const mesas = new Map(); // one Mesa per order in fixture mode, so each visitor gets an isolated simulator
// Sandbox mode persists orders (DATA_DIR) and recovers them on restart. Fixture mode keeps one simulator per visitor in memory.
const mesaSandbox = paypal ? new Mesa({ paypal, brief: B0, amostra: AMOSTRA, store: new StoreArquivo(`${process.env.DATA_DIR || './data'}/orders.json`) }) : null;
const verificarWebhook = mesaSandbox && process.env.PAYPAL_WEBHOOK_ID ? criarVerificador({ webhookId: process.env.PAYPAL_WEBHOOK_ID, buscarCert: buscarCertHttps }) : null;
const gerar = process.env.GEMINI_API_KEY ? geradorGemini() : async () => { throw new Error('advisory model not configured'); };

function mesaDe(id) {
  if (mesaSandbox) return mesaSandbox;
  const m = mesas.get(id); if (!m) throw new ErroRegra('ORDER_NOT_FOUND', id); return m;
}

function vista(m, p) {
  const permitido = m.podeCapturar(p, { li_rejeicoes: true })[0];
  return {
    modo: MODO, id: p.id, estado: p.estado, cor: p.cor, valor: p.valor, moeda: p.moeda,
    order_id: p.order_id, autorizacao_id: p.autorizacao_id, capture_id: p.capture_id, aprovacao_url: p.aprovacao_url,
    relatorio: p.relatorio, parecer: p.parecer, avisos: m.avisos(p.id), alertas: p.alertas, contadores: p.contadores,
    reentregas: p.reentregas, captura_disponivel: permitido, trilha: p.trilha.slice(-30),
  };
}

const corpo = (req) => new Promise((ok, falha) => {
  let n = 0; const partes = [];
  req.on('data', (c) => { n += c.length; if (n > MAX_LOTE) { falha(new ErroRegra('TOO_LARGE', 'file above 200 KB')); req.destroy(); } else partes.push(c); });
  req.on('end', () => ok(Buffer.concat(partes).toString('utf8'))); req.on('error', falha);
});
const json = (res, st, obj) => { res.writeHead(st, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

async function rota(req, res) {
  const u = new URL(req.url, BASE_URL);
  const m = u.pathname.match(/^\/api\/pedidos\/([\w-]{1,64})(?:\/(\w+))?$/);
  if (req.method === 'GET' && u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' });
    return res.end(readFileSync(new URL('web/index.html', RAIZ)));
  }
  if (req.method === 'GET' && u.pathname === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(readFileSync(new URL('web/app.js', RAIZ))); }
  if (req.method === 'GET' && u.pathname === '/api/info') return json(res, 200, { modo: MODO, brief: B0, lotes: Object.keys(LOTES), parecer: !!process.env.GEMINI_API_KEY });
  if (req.method === 'GET' && u.pathname === '/retorno') {
    const token = u.searchParams.get('token');
    const p = mesaSandbox && [...mesaSandbox.pedidos.values()].find((x) => x.order_id === token);
    if (p && p.estado === 'CREATED') await mesaSandbox.autorizar(p.id);
    res.writeHead(302, { location: p ? `/#${p.id}` : '/' }); return res.end();
  }
  if (req.method === 'POST' && u.pathname === '/webhooks/paypal') {
    if (!verificarWebhook) return json(res, 404, { erro: 'webhooks are only enabled in sandbox mode with PAYPAL_WEBHOOK_ID' });
    const bruto = await corpo(req);
    const v = await verificarWebhook(req.headers, bruto);
    if (!v.ok) return json(res, 400, { erro: `webhook rejected: ${v.motivo}` });
    let ev; try { ev = JSON.parse(bruto); } catch { return json(res, 400, { erro: 'webhook body is not JSON' }); }
    return json(res, 200, mesaSandbox.webhook(ev));
  }
  if (req.method === 'POST' && u.pathname === '/api/pedidos') {
    const id = randomUUID().slice(0, 8);
    const mesa = mesaSandbox || new Mesa({ paypal: new PayPalFixture(), brief: B0, amostra: AMOSTRA });
    if (!mesaSandbox) { mesas.set(id, mesa); if (mesas.size > 500) mesas.delete(mesas.keys().next().value); }
    const p = await mesa.criar({ id, valor: '50.00', moeda: 'USD' });
    if (!mesaSandbox) await mesa.autorizar(id); // fixture: buyer approval is simulated and labeled
    return json(res, 201, vista(mesa, mesa.pedido(p.id)));
  }
  if (!m) return json(res, 404, { erro: 'not found' });
  const [, id, acao] = m; const mesa = mesaDe(id);
  if (req.method === 'GET' && !acao) return json(res, 200, vista(mesa, mesa.pedido(id)));
  if (req.method !== 'POST') return json(res, 405, { erro: 'method not allowed' });
  const txt = await corpo(req); const dados = txt && acao !== 'entrega' ? JSON.parse(txt) : {};
  switch (acao) {
    case 'entrega': {
      const nome = u.searchParams.get('lote');
      const lote = nome ? LOTES[nome] : txt;
      if (!lote) throw new ErroRegra('FILE', 'unknown or empty file');
      mesa.entregar(id, lote); mesa.conferir(id); break;
    }
    case 'parecer': await mesa.parecer(id, gerar); break;
    case 'capturar': await mesa.capturar(id, { humano: dados.confirmo === true, li_rejeicoes: dados.li_rejeicoes === true }); break;
    case 'reentrega': mesa.pedirReentrega(id); break;
    case 'anular': await mesa.anular(id, { humano: dados.confirmo === true }); break;
    case 'reautorizar': await mesa.reautorizar(id, { humano: dados.confirmo === true }); break;
    case 'reconciliar': await mesa.reconciliar(id); break;
    default: return json(res, 404, { erro: 'unknown action' });
  }
  return json(res, 200, vista(mesa, mesa.pedido(id)));
}

createServer((req, res) => {
  rota(req, res).catch((e) => json(res, e instanceof ErroRegra ? 409 : 500, { erro: e instanceof ErroRegra ? e.message : 'internal error', codigo: e.codigo }));
}).listen(PORTA, () => console.log(`mode ${MODO} on ${BASE_URL}`));
