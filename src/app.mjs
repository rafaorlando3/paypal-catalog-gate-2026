// HTTP application for the demo. Two modes, always run as separate processes with separate data:
//  - fixture (public): simulated PayPal, one isolated simulator per order, orders bound to the visitor's session.
//  - sandbox (protected): PayPal sandbox REST, persisted orders, every order route requires an operator login.
// Every mutation (POST) needs a session cookie, the per-session CSRF token in X-CG-CSRF and a same-origin Origin header.
// The signed PayPal webhook is the only POST without a session; it is authenticated by its signature instead.
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { Mesa, ErroRegra } from './pedido.mjs';
import { PayPalFixture } from './paypal-fixture.mjs';
import { B0 } from './brief.mjs';
import { adaptadorDoAmbiente, erroIA } from './c3/adaptador.mjs';

const RAIZ = new URL('..', import.meta.url);
const LOTES = Object.fromEntries(readdirSync(new URL('fixtures/L0/', RAIZ)).filter((n) => n.startsWith('L0')).map((n) => [n, readFileSync(new URL(`fixtures/L0/${n}`, RAIZ), 'utf8')]));
// C3 development lots are selectable in the demo; the reserved evaluation lots are never served.
for (const n of readdirSync(new URL('fixtures/C3/', RAIZ)).filter((x) => /^C3-V\d-dev-.*\.csv$/.test(x))) LOTES[n] = readFileSync(new URL(`fixtures/C3/${n}`, RAIZ), 'utf8');
const AMOSTRA = readFileSync(new URL('fixtures/L0/AMOSTRA-L0-linhas-2-11.csv', RAIZ), 'utf8');
const MAX_CORPO = 200 * 1024;
const COOKIE = 'cg_sid';
const SESSAO_MS = 2 * 3600 * 1000;

const igual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const sha256 = (t) => createHash('sha256').update(t).digest('hex');
class ErroHttp extends Error { constructor(st, codigo, msg) { super(msg); this.st = st; this.codigo = codigo; } }

/**
 * @param {object} c
 * @param {'fixture'|'sandbox'} c.modo
 * @param {string} c.baseUrl            public origin, used for the Origin check and cookie flags
 * @param {object} [c.paypal]           sandbox: PayPal client (PayPalRest in production; tests inject the fixture)
 * @param {object} [c.store]            sandbox: persistent store (StoreArquivo)
 * @param {string} [c.operadorSha256]   sandbox: sha256 hex of the operator token (OPERATOR_TOKEN_SHA256)
 * @param {Function} [c.verificarWebhook] sandbox: signature verifier from webhook.mjs
 * @param {Function} [c.gerar]          advisory model call; absent means the advisory is unavailable
 * @param {object} [c.ia]             C3 suggestion adapter; default adaptadorDoAmbiente(), which is always OFF in C3
 * @param {object} [c.limites]          { pedidosPorSessao, mesas, llmPorDia, llmPorSessao, llmPorPedido, falhasLogin }
 */
export function criarApp(c) {
  const modo = c.modo === 'sandbox' ? 'sandbox' : 'fixture';
  const origem = new URL(c.baseUrl).origin;
  const seguro = origem.startsWith('https:');
  const L = { pedidosPorSessao: 20, mesas: 500, llmPorDia: 50, llmPorSessao: 5, llmPorPedido: 3, falhasLogin: 10, ...(c.limites || {}) };
  const agora = c.agora || (() => Date.now());
  if (modo === 'sandbox') {
    if (!c.paypal || !c.store) throw new Error('sandbox mode needs a PayPal client and a persistent store');
    if (!/^[0-9a-f]{64}$/.test(c.operadorSha256 || '')) throw new Error('sandbox mode needs OPERATOR_TOKEN_SHA256 (64 hex characters)');
  }
  const sessoes = new Map();
  const mesas = new Map(); // fixture: order id -> its own simulator
  const mesaSandbox = modo === 'sandbox' ? new Mesa({ paypal: c.paypal, brief: B0, amostra: AMOSTRA, store: c.store, limiteParecer: { porPedido: L.llmPorPedido, porDia: L.llmPorDia } }) : null;
  const llm = { dia: '', chamadas: 0 };
  const login = { janela: 0, falhas: 0 };

  // ---------- sessions ----------
  function novaSessao(operador = false) {
    for (const [k, s] of sessoes) if (s.expira < agora()) sessoes.delete(k);
    if (sessoes.size >= 5000) sessoes.delete(sessoes.keys().next().value);
    const s = { id: randomBytes(32).toString('base64url'), csrf: randomBytes(32).toString('base64url'), expira: agora() + SESSAO_MS, operador, pedidos: 0, llm: 0 };
    sessoes.set(s.id, s); return s;
  }
  function sessaoDe(req) {
    const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]{43})`));
    const s = m && sessoes.get(m[1]);
    if (!s || s.expira < agora()) return null;
    s.expira = agora() + SESSAO_MS; return s;
  }
  const cookieDe = (s) => `${COOKIE}=${s.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSAO_MS / 1000}${seguro ? '; Secure' : ''}`;

  function exigirMutacao(req, s) {
    if (req.headers.origin !== origem) throw new ErroHttp(403, 'BAD_ORIGIN', 'cross-origin or missing Origin header');
    if (!s) throw new ErroHttp(403, 'NO_SESSION', 'session required; load the page first');
    if (!igual(req.headers['x-cg-csrf'] || '', s.csrf)) throw new ErroHttp(403, 'CSRF', 'missing or wrong CSRF token');
  }

  // ---------- advisory budget (process-wide per day, per session, and per order inside Mesa) ----------
  function gerarCom(s) {
    return async (prompt) => {
      const hoje = new Date(agora()).toISOString().slice(0, 10);
      if (llm.dia !== hoje) { llm.dia = hoje; llm.chamadas = 0; }
      if (!c.gerar) throw new Error('advisory model not configured');
      if (llm.chamadas >= L.llmPorDia || s.llm >= L.llmPorSessao) throw new Error('advisory budget reached');
      llm.chamadas++; s.llm++; // counted before the call
      return c.gerar(prompt);
    };
  }

  /** The C3 adapter behind the same process-wide and per-session advisory budget as the explanation. */
  function iaCom(s) {
    const ia = c.ia || adaptadorDoAmbiente();
    if (ia.habilitado !== true) return ia;
    return { habilitado: true, modelo: ia.modelo, async propor(prompt) {
      const hoje = new Date(agora()).toISOString().slice(0, 10);
      if (llm.dia !== hoje) { llm.dia = hoje; llm.chamadas = 0; }
      if (llm.chamadas >= L.llmPorDia || s.llm >= L.llmPorSessao) throw erroIA('advisory_budget_reached');
      llm.chamadas++; s.llm++; // counted before the call
      return ia.propor(prompt);
    } };
  }

  // ---------- orders ----------
  function acessar(s, id) {
    if (modo === 'sandbox') {
      if (!s?.operador) throw new ErroHttp(401, 'OPERATOR_REQUIRED', 'operator login required in sandbox mode');
      if (!mesaSandbox.pedidos.has(id)) throw new ErroHttp(404, 'ORDER_NOT_FOUND', 'order not found');
      return mesaSandbox;
    }
    const m = mesas.get(id);
    // Another visitor's order answers exactly like a missing one.
    if (!m || !s || m.pedido(id).dono !== s.id) throw new ErroHttp(404, 'ORDER_NOT_FOUND', 'order not found');
    return m;
  }

  function vista(m, p) {
    return {
      modo, id: p.id, estado: p.estado, cor: p.cor, valor: p.valor, moeda: p.moeda,
      order_id: p.order_id, autorizacao_id: p.autorizacao_id, capture_id: p.capture_id, aprovacao_url: p.aprovacao_url,
      relatorio: p.relatorio, parecer: p.parecer, avisos: m.avisos(p.id), alertas: p.alertas, contadores: p.contadores,
      reentregas: p.reentregas, incerto: p.incerto, lote_sha256: p.lote_sha256, revisao_entrega: p.revisao_entrega ?? 0, sugestoes: p.sugestoes || null, captura_disponivel: m.podeCapturar(p, { li_rejeicoes: true })[0], trilha: p.trilha.slice(-30),
    };
  }

  const corpo = (req) => new Promise((ok, falha) => {
    let n = 0; const partes = [];
    req.on('data', (b) => { n += b.length; if (n > MAX_CORPO) { falha(new ErroHttp(413, 'TOO_LARGE', 'body above 200 KB')); req.destroy(); } else partes.push(b); });
    req.on('end', () => ok(Buffer.concat(partes).toString('utf8'))); req.on('error', falha);
  });
  const jsonDe = (txt) => { if (!txt) return {}; try { return JSON.parse(txt); } catch { throw new ErroHttp(400, 'BAD_JSON', 'body is not JSON'); } };
  const json = (res, st, obj, extra = {}) => { res.writeHead(st, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra }); res.end(JSON.stringify(obj)); };

  async function rota(req, res) {
    const u = new URL(req.url, origem);
    const s = sessaoDe(req);
    if (req.method === 'GET' && u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; form-action 'self'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      return res.end(readFileSync(new URL('web/index.html', RAIZ)));
    }
    if (req.method === 'GET' && u.pathname === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' }); return res.end(readFileSync(new URL('web/app.js', RAIZ))); }
    if (req.method === 'GET' && u.pathname === '/vinculo-reentrega.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' }); return res.end(readFileSync(new URL('web/vinculo-reentrega.js', RAIZ))); }
    if (req.method === 'GET' && u.pathname === '/api/info') {
      const sess = s || novaSessao();
      return json(res, 200, { modo, brief: B0, lotes: Object.keys(LOTES), parecer: !!c.gerar, sugestoes_ia: (c.ia || adaptadorDoAmbiente()).habilitado === true, csrf: sess.csrf, operador: sess.operador, login_exigido: modo === 'sandbox' }, s ? {} : { 'set-cookie': cookieDe(sess) });
    }
    if (req.method === 'GET' && u.pathname === '/retorno') {
      // Return from the buyer's PayPal approval. No state change on GET: the operator authorizes with a POST.
      const p = mesaSandbox && [...mesaSandbox.pedidos.values()].find((x) => x.order_id === u.searchParams.get('token'));
      res.writeHead(302, { location: p ? `/#${p.id}` : '/' }); return res.end();
    }
    if (req.method === 'POST' && u.pathname === '/webhooks/paypal') {
      if (!mesaSandbox || !c.verificarWebhook) return json(res, 404, { erro: 'webhooks are only enabled in sandbox mode with PAYPAL_WEBHOOK_ID' });
      const bruto = await corpo(req);
      const v = await c.verificarWebhook(req.headers, bruto);
      if (!v.ok) return json(res, 400, { erro: `webhook rejected: ${v.motivo}` });
      return json(res, 200, mesaSandbox.webhook(jsonDe(bruto)));
    }
    if (req.method === 'POST') exigirMutacao(req, s);

    if (req.method === 'POST' && u.pathname === '/api/login') {
      if (modo !== 'sandbox') throw new ErroHttp(404, 'NOT_FOUND', 'login exists only in sandbox mode');
      if (agora() - login.janela > 15 * 60 * 1000) { login.janela = agora(); login.falhas = 0; }
      if (login.falhas >= L.falhasLogin) throw new ErroHttp(429, 'LOGIN_LOCKED', 'too many failed logins; wait 15 minutes');
      const { token } = jsonDe(await corpo(req));
      if (typeof token !== 'string' || !igual(sha256(token), c.operadorSha256)) { login.falhas++; throw new ErroHttp(401, 'LOGIN_FAILED', 'wrong operator token'); }
      sessoes.delete(s.id); const nova = novaSessao(true); // new id after login (no session fixation)
      return json(res, 200, { operador: true, csrf: nova.csrf }, { 'set-cookie': cookieDe(nova) });
    }
    if (req.method === 'POST' && u.pathname === '/api/logout') { sessoes.delete(s.id); return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` }); }

    if (req.method === 'POST' && u.pathname === '/api/pedidos') {
      const id = randomUUID().slice(0, 8);
      if (modo === 'sandbox') {
        if (!s.operador) throw new ErroHttp(401, 'OPERATOR_REQUIRED', 'operator login required in sandbox mode');
        await mesaSandbox.criar({ id, valor: '50.00', moeda: 'USD', dono: 'operator' });
        return json(res, 201, vista(mesaSandbox, mesaSandbox.pedido(id)));
      }
      if (s.pedidos >= L.pedidosPorSessao) throw new ErroHttp(429, 'ORDER_LIMIT', 'order limit for this session reached');
      const mesa = new Mesa({ paypal: new PayPalFixture(), brief: B0, amostra: AMOSTRA, limiteParecer: { porPedido: L.llmPorPedido, porDia: L.llmPorDia } });
      mesas.set(id, mesa); s.pedidos++;
      if (mesas.size > L.mesas) mesas.delete(mesas.keys().next().value);
      await mesa.criar({ id, valor: '50.00', moeda: 'USD', dono: s.id });
      await mesa.autorizar(id); // fixture: buyer approval is simulated and labeled
      return json(res, 201, vista(mesa, mesa.pedido(id)));
    }

    const m = u.pathname.match(/^\/api\/pedidos\/([\w-]{1,64})(?:\/(\w+))?$/);
    if (!m) return json(res, 404, { erro: 'not found' });
    const [, id, acao] = m;
    const mesa = acessar(s, id);
    if (req.method === 'GET' && !acao) return json(res, 200, vista(mesa, mesa.pedido(id)));
    if (req.method !== 'POST') return json(res, 405, { erro: 'method not allowed' });
    const txt = await corpo(req);
    const dados = acao === 'entrega' ? {} : jsonDe(txt);
    const humano = dados.confirmo === true;
    switch (acao) {
      case 'entrega': {
        const nome = u.searchParams.get('lote');
        const lote = nome ? LOTES[nome] : txt;
        if (!lote) throw new ErroRegra('FILE', 'unknown or empty file');
        mesa.entregar(id, lote); mesa.conferir(id); break;
      }
      case 'autorizar': if (modo !== 'sandbox') throw new ErroRegra('STATE', 'fixture orders are authorized at creation'); await mesa.autorizar(id); break;
      case 'parecer': await mesa.parecer(id, gerarCom(s)); break;
      case 'capturar': await mesa.capturar(id, { humano, li_rejeicoes: dados.li_rejeicoes === true }); break;
      case 'reentrega': mesa.pedirReentrega(id); break;
      case 'anular': await mesa.anular(id, { humano }); break;
      case 'reautorizar': await mesa.reautorizar(id, { humano }); break;
      case 'reconciliar': await mesa.reconciliar(id); break;
      case 'sugerir': await mesa.sugerir(id, { ia: iaCom(s) }); break;
      case 'decidir_sugestao': mesa.decidirSugestao(id, String(dados.sid || ''), { fonte: dados.fonte, aceitar: dados.aceitar === true, humano }); break;
      case 'pedido_reentrega': {
        if (!['es', 'pt'].includes(dados.idioma)) throw new ErroRegra('LANGUAGE', 'idioma must be es or pt');
        const reentrega = mesa.pedidoReentregaVinculado(id, dados.idioma);
        return json(res, 200, { ...vista(mesa, mesa.pedido(id)), reentrega, texto_reentrega: reentrega.texto });
      }
      default: return json(res, 404, { erro: 'unknown action' });
    }
    return json(res, 200, vista(mesa, mesa.pedido(id)));
  }

  const servidor = createServer((req, res) => {
    rota(req, res).catch((e) => {
      if (e instanceof ErroHttp) return json(res, e.st, { erro: e.message, codigo: e.codigo });
      if (e instanceof ErroRegra) return json(res, 409, { erro: e.message, codigo: e.codigo });
      return json(res, 500, { erro: 'internal error' });
    });
  });
  return { servidor, mesaSandbox, sessoes };
}
