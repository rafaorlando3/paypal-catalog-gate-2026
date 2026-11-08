// Order state machine for R1: authorize first, capture the full authorized amount only after a
// deterministic verdict plus an explicit human click. The model never enables capture.
// PayPal references (read 08/11/2026):
//  - Orders v2 authorize: https://developer.paypal.com/api/orders/v2/orders-authorize
//  - Payments v2 capture (final_capture): https://developer.paypal.com/api/payments/v2/authorizations-capture
//  - Honor period, 29-day validity, reauthorization: https://developer.paypal.com/docs/checkout/advanced/authorization-honor/
//  - PayPal-Request-Id idempotency: https://developer.paypal.com/api/rest/reference/idempotency/
import { createHash } from 'node:crypto';
import { validar } from './validar.mjs';
import { checarParecer } from './parecer.mjs';

const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const DIA = 86400000;

export class ErroRegra extends Error {
  constructor(codigo, msg) { super(`${codigo}: ${msg}`); this.codigo = codigo; }
}

/** JSON with sorted keys, so the payload hash does not depend on key order. */
export function canonico(v) {
  if (Array.isArray(v)) return `[${v.map(canonico).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonico(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** Deterministic PayPal-Request-Id in UUID shape (36 chars; the docs recommend a UUID, max 38). */
export function requestIdDe(...partes) {
  const h = sha256(partes.join('|'));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Forward-only ranking used by webhooks.
const RANK = { CREATED: 0, AUTHORIZED: 1, DELIVERED: 2, CHECKED: 3, CAPTURE_REQUESTED: 4, CAPTURE_PENDING: 5, CAPTURED: 9, CAPTURE_DECLINED: 9, VOIDED: 9, EXPIRED: 9 };
const VIVOS = ['AUTHORIZED', 'DELIVERED', 'CHECKED'];

export class Mesa {
  /**
   * @param {object} o
   * @param {object} o.paypal   client with the PayPal REST subset (sandbox REST or fixture)
   * @param {() => number} [o.agora]  clock in ms
   * @param {object} [o.brief]
   * @param {string} [o.amostra] approved sample lines (no header)
   * @param {object} [o.store]   persistence with ler() and gravar(estado); see store.mjs
   */
  constructor({ paypal, agora = () => Date.now(), brief, amostra, store = null }) {
    Object.assign(this, { paypal, agora, brief, amostra, store });
    this.pedidos = new Map();
    this.travas = new Map();
    this.eventos = new Set();
    this.log = [];
    if (store) this.#recuperar(store.ler());
  }

  // ---------- persistence and recovery ----------
  #recuperar(estado) {
    if (!estado) return;
    for (const p of estado.pedidos || []) this.pedidos.set(p.id, p);
    for (const e of estado.eventos || []) this.eventos.add(e);
    for (const p of this.pedidos.values()) {
      // A restart while a capture POST was in flight: we cannot know whether PayPal received it.
      if (p.estado === 'CAPTURE_REQUESTED') {
        p.estado = 'UNCERTAIN'; p.incerto = 'capture';
        this.#registrar(p, 'restart during capture: state uncertain, reconcile by GET');
        p.alertas.push({ t: new Date(this.agora()).toISOString(), msg: 'Restart while a capture was in flight. Reconcile with PayPal before any other action.' });
      }
    }
    this.#salvar();
  }

  #salvar() {
    if (this.store) this.store.gravar({ versao: 1, pedidos: [...this.pedidos.values()], eventos: [...this.eventos] });
  }

  #trava(id, fn) {
    const anterior = this.travas.get(id) || Promise.resolve();
    const atual = anterior.catch(() => {}).then(fn).finally(() => this.#salvar());
    this.travas.set(id, atual.catch(() => {}));
    return atual;
  }

  #registrar(p, evento, extra = {}) {
    const linha = { t: new Date(this.agora()).toISOString(), pedido: p.id, estado: p.estado, evento, ...extra };
    p.trilha.push(linha);
    this.log.push(linha);
  }

  #alerta(p, msg) { p.alertas.push({ t: new Date(this.agora()).toISOString(), msg }); this.#registrar(p, 'alert', { msg }); }

  pedido(id) {
    const p = this.pedidos.get(id);
    if (!p) throw new ErroRegra('ORDER_NOT_FOUND', id);
    this.#expirar(p);
    return p;
  }

  #dias(p) { return p.autorizado_em == null ? 0 : Math.floor((this.agora() - p.autorizado_em) / DIA); }
  #diasAutAtual(p) { return p.aut_atual_em == null ? 0 : Math.floor((this.agora() - p.aut_atual_em) / DIA); }

  #expirar(p) {
    if (p.autorizado_em != null && this.#dias(p) >= 30 && [...VIVOS, 'REDELIVERY'].includes(p.estado)) {
      p.estado = 'EXPIRED';
      this.#registrar(p, 'authorization expired', { msg: 'a new authorization needs a new order' });
      this.#salvar();
    }
  }

  /** Honor period warning (day 4 onwards of the current authorization). */
  avisos(id) {
    const p = this.pedido(id);
    const out = [];
    if (p.estado === 'EXPIRED') out.push('Authorization expired: a new authorization needs a new order.');
    else if (p.autorizacao_id && this.#diasAutAtual(p) >= 3 && [...VIVOS, 'REDELIVERY'].includes(p.estado)) out.push('Honor period over: the capture may fail. Reauthorizing needs a human click (once, from day 4 to day 29).');
    return out;
  }

  async criar({ id, valor = '50.00', moeda = 'USD' }) {
    if (this.pedidos.has(id)) throw new ErroRegra('ORDER_EXISTS', id);
    const p = { id, valor, moeda, estado: 'CREATED', trilha: [], alertas: [], requisicoes: {}, contadores: { posts_capture: 0, posts_void: 0, posts_reauth: 0, capturas_ok: 0 }, reentregas: 0, reautorizacoes: 0, autorizacoes_substituidas: [] };
    this.pedidos.set(id, p);
    try {
      const ordem = await this.paypal.criarPedido({ valor, moeda, requestId: requestIdDe(id, 'create') });
      p.order_id = ordem.id;
      p.aprovacao_url = ordem.aprovacao_url;
      this.#registrar(p, 'PayPal order created', { order_id: ordem.id });
    } finally { this.#salvar(); }
    return p;
  }

  /** After the buyer approved the order in PayPal: authorize it (funds held, not captured). */
  async autorizar(id) {
    return this.#trava(id, async () => {
      const p = this.pedido(id);
      if (p.estado !== 'CREATED') throw new ErroRegra('STATE', `authorize needs CREATED, order is ${p.estado}`);
      const a = await this.paypal.autorizarPedido({ orderId: p.order_id, requestId: requestIdDe(id, 'authorize', p.order_id) });
      if (!a?.id) throw new ErroRegra('NO_AUTHORIZATION', 'PayPal returned no authorization id');
      p.autorizacao_id = a.id; p.autorizacao_original = a.id;
      p.autorizado_em = this.agora(); p.aut_atual_em = this.agora();
      p.estado = 'AUTHORIZED';
      this.#registrar(p, 'authorized', { authorization_id: a.id, status: a.status });
      return p;
    });
  }

  entregar(id, lote) {
    const p = this.pedido(id);
    if (!['AUTHORIZED', 'REDELIVERY'].includes(p.estado)) throw new ErroRegra('STATE', `delivery needs AUTHORIZED or REDELIVERY, order is ${p.estado}`);
    p.lote = lote; p.lote_sha256 = sha256(lote); p.estado = 'DELIVERED';
    delete p.relatorio; delete p.parecer; delete p.cor;
    this.#registrar(p, 'file delivered', { lote_sha256: p.lote_sha256 });
    this.#salvar();
    return p;
  }

  conferir(id) {
    const p = this.pedido(id);
    if (p.estado !== 'DELIVERED') throw new ErroRegra('STATE', `check needs DELIVERED, order is ${p.estado}`);
    p.relatorio = validar(this.brief, p.lote, this.amostra);
    p.estado = 'CHECKED';
    p.cor = p.relatorio.veredito;
    this.#registrar(p, 'checked', { veredito: p.cor, validas: p.relatorio.validas, rejeicoes: p.relatorio.rejeicoes.length });
    this.#salvar();
    return p.relatorio;
  }

  /** Advisory text from a model. Checked against the report; it can never enable or block capture. */
  async parecer(id, gerar) {
    const p = this.pedido(id);
    if (!p.relatorio) throw new ErroRegra('STATE', 'an advisory needs a check report');
    let texto;
    try { texto = await gerar(p.relatorio, this.brief); } catch (e) {
      p.parecer = { estado: 'unavailable', texto: 'Advisory unavailable', motivo: String(e.message || e) };
      this.#registrar(p, 'advisory unavailable', { motivo: p.parecer.motivo });
      this.#salvar();
      return p.parecer;
    }
    const chk = checarParecer(texto, p.relatorio);
    p.parecer = chk.ok ? { estado: 'accepted', texto, rotulo: 'advisory, not a decision' } : { estado: 'rejected', texto, motivo: chk.motivo, rotulo: 'advisory rejected by the checker' };
    this.#registrar(p, `advisory ${p.parecer.estado}`, chk.ok ? {} : { motivo: chk.motivo });
    this.#salvar();
    return p.parecer;
  }

  podeCapturar(p, { li_rejeicoes = false } = {}) {
    if (p.estado !== 'CHECKED') return [false, `state ${p.estado}`];
    if (p.capture_id) return [false, 'order already has a capture id'];
    if (p.cor === 'verde') return [true];
    if (p.cor === 'amarelo') return li_rejeicoes ? [true] : [false, `confirm "I read the ${p.relatorio.rejeicoes.length} rejected rows"`];
    return [false, 'verdict FAIL'];
  }

  /** Records the request id and payload hash before sending; the same id with another payload is blocked locally. */
  #preparar(p, op, payload) {
    const requestId = requestIdDe(p.id, op, p.autorizacao_id);
    const hash = sha256(canonico(payload));
    const antes = p.requisicoes[requestId];
    if (antes && antes.hash !== hash) {
      this.#alerta(p, `same PayPal-Request-Id with a different payload for ${op}; nothing was sent`);
      throw new ErroRegra('REQUEST_ID_PAYLOAD_MISMATCH', `${op} ${requestId.slice(0, 8)}`);
    }
    p.requisicoes[requestId] = { op, hash, payload };
    return requestId;
  }

  /** The full authorized amount, stated explicitly, with final_capture: true (no partial capture). */
  payloadCaptura(p) { return { amount: { currency_code: p.moeda, value: p.valor }, final_capture: true }; }

  /** Human click "capture". */
  async capturar(id, { humano = false, li_rejeicoes = false } = {}) {
    if (!humano) throw new ErroRegra('NO_HUMAN_CLICK', 'capture needs a human click');
    return this.#trava(id, async () => {
      const p = this.pedido(id);
      const [ok, motivo] = this.podeCapturar(p, { li_rejeicoes });
      if (!ok) { this.#registrar(p, 'capture refused locally', { motivo }); return p; }
      return this.#enviarCaptura(p, this.payloadCaptura(p));
    });
  }

  /** A retry of a capture whose answer was lost. Never sends: reconciliation is by GET only. */
  async repetirCaptura(id, payload) {
    return this.#trava(id, async () => {
      const p = this.pedido(id);
      this.#preparar(p, 'capture', payload ?? this.payloadCaptura(p)); // throws on a divergent payload first
      throw new ErroRegra('CAPTURE_BLOCKED', `invariant 8: ${p.estado}${p.capture_id ? ' with capture id' : ''}; reconcile by GET`);
    });
  }

  async #enviarCaptura(p, payload) {
    const requestId = this.#preparar(p, 'capture', payload);
    p.estado = 'CAPTURE_REQUESTED';
    p.contadores.posts_capture++;
    this.#registrar(p, 'capture requested', { requestId: requestId.slice(0, 8) });
    this.#salvar(); // persisted before the POST, so a crash here is recovered as UNCERTAIN
    let r;
    try {
      r = await this.paypal.capturar({ autorizacaoId: p.autorizacao_id, payload, requestId });
    } catch (e) {
      if (e.incerto) { p.estado = 'UNCERTAIN'; p.incerto = 'capture'; this.#registrar(p, 'no answer from PayPal', { motivo: e.message }); return p; }
      p.estado = 'CAPTURE_DECLINED'; this.#registrar(p, 'capture refused by PayPal', { motivo: e.message }); return p;
    }
    return this.#aplicarCaptura(p, r);
  }

  #aplicarCaptura(p, r) {
    if (r.status === 'COMPLETED') {
      p.capture_id = r.id; p.estado = 'CAPTURED'; p.contadores.capturas_ok = 1; delete p.incerto;
      this.#registrar(p, 'captured', { capture_id: r.id });
    } else if (r.status === 'PENDING') {
      p.capture_id = r.id; p.estado = 'CAPTURE_PENDING';
      this.#registrar(p, 'capture pending (not received)', { capture_id: r.id });
    } else {
      p.capture_id = r.id; p.estado = 'CAPTURE_DECLINED';
      this.#registrar(p, 'capture declined', { status: r.status });
    }
    return p;
  }

  /** Reconciliation by GET only. Never sends a new POST. */
  async reconciliar(id) {
    return this.#trava(id, async () => {
      const p = this.pedido(id);
      if (p.estado === 'CAPTURE_PENDING') {
        const c = await this.paypal.obterCaptura(p.capture_id);
        if (c.status === 'COMPLETED' && this.#confere(p, c)) return this.#aplicarCaptura(p, c);
        if (['DECLINED', 'FAILED'].includes(c.status)) return this.#aplicarCaptura(p, c);
        this.#registrar(p, 'capture still pending', { status: c.status });
        return p;
      }
      if (p.estado === 'UNCERTAIN' && p.incerto === 'capture') {
        const a = await this.paypal.obterAutorizacao(p.autorizacao_id);
        const k = a.supplementary_data?.related_ids?.capture_id;
        if (a.status === 'CAPTURED' && k) {
          const c = await this.paypal.obterCaptura(k);
          if (['COMPLETED', 'PENDING'].includes(c.status) && this.#confere(p, c)) return this.#aplicarCaptura(p, c);
        }
        if (a.status === 'CREATED' && !k) {
          this.#alerta(p, 'PayPal shows the authorization still open. A person decides whether to capture again; the system will not resend on its own.');
          return p;
        }
        this.#alerta(p, 'probable capture without a verifiable link; capture, void and reauthorization stay blocked until a person reviews');
        return p;
      }
      if (VIVOS.includes(p.estado) && p.autorizacao_id) {
        const a = await this.paypal.obterAutorizacao(p.autorizacao_id);
        if (a.status !== 'CREATED') {
          p.divergencia = { local: p.estado, paypal: a.status };
          p.estado = 'UNCERTAIN'; p.incerto = 'divergence';
          this.#alerta(p, `divergence: local ${p.divergencia.local}, PayPal ${a.status}; no action until a person reviews`);
        }
      }
      return p;
    });
  }

  #confere(p, c) {
    return c.amount?.value === p.valor && c.amount?.currency_code === p.moeda && c.supplementary_data?.related_ids?.authorization_id === p.autorizacao_id;
  }

  async anular(id, { humano = false } = {}) {
    if (!humano) throw new ErroRegra('NO_HUMAN_CLICK', 'void needs a human click');
    return this.#trava(id, async () => {
      const p = this.pedido(id);
      if (!VIVOS.includes(p.estado)) { this.#registrar(p, 'void blocked', { motivo: `state ${p.estado}` }); return p; }
      const requestId = this.#preparar(p, 'void', {});
      p.contadores.posts_void++;
      await this.paypal.anular({ autorizacaoId: p.autorizacao_id, requestId });
      p.estado = 'VOIDED';
      this.#registrar(p, 'voided');
      return p;
    });
  }

  async reautorizar(id, { humano = false } = {}) {
    if (!humano) throw new ErroRegra('NO_HUMAN_CLICK', 'reauthorization needs a human click');
    return this.#trava(id, async () => {
      const p = this.pedido(id);
      const d = this.#dias(p);
      if (!VIVOS.includes(p.estado)) { this.#registrar(p, 'reauthorization blocked', { motivo: `state ${p.estado}` }); return p; }
      if (p.reautorizacoes >= 1) { this.#registrar(p, 'reauthorization blocked', { motivo: 'invariant 7: at most one' }); return p; }
      if (d < 3 || d > 29) { this.#registrar(p, 'reauthorization blocked', { motivo: `day ${d + 1}; allowed from day 4 to day 29` }); return p; }
      const payload = { amount: { currency_code: p.moeda, value: p.valor } };
      const requestId = this.#preparar(p, 'reauthorize', payload);
      p.contadores.posts_reauth++;
      const a = await this.paypal.reautorizar({ autorizacaoId: p.autorizacao_id, payload, requestId });
      p.autorizacoes_substituidas.push(p.autorizacao_id);
      p.autorizacao_id = a.id; p.aut_atual_em = this.agora(); p.reautorizacoes++;
      this.#registrar(p, 'reauthorized', { authorization_id: a.id });
      return p;
    });
  }

  pedirReentrega(id) {
    const p = this.pedido(id);
    if (p.estado !== 'CHECKED' || p.cor === 'verde') throw new ErroRegra('STATE', 'a new delivery is only asked after a PASS WITH REJECTIONS or FAIL check');
    if (p.reentregas >= 2) throw new ErroRegra('LIMIT', 'at most 2 redeliveries; void or negotiate');
    p.reentregas++; p.estado = 'REDELIVERY';
    this.#registrar(p, 'new delivery requested', { contador: p.reentregas });
    this.#salvar();
    return p;
  }

  /**
   * Webhooks, after signature verification by the caller: deduplicated by event id (persisted),
   * applied forward only. Event names from https://developer.paypal.com/api/rest/webhooks/event-names/
   */
  webhook(evento) {
    if (!evento?.id) return { aplicado: false, motivo: 'event without id' };
    if (this.eventos.has(evento.id)) return { aplicado: false, motivo: 'duplicate' };
    this.eventos.add(evento.id);
    try {
      const r = evento.resource || {};
      const p = [...this.pedidos.values()].find((x) => x.autorizacao_id === r.supplementary_data?.related_ids?.authorization_id || x.autorizacao_id === r.id || x.capture_id === r.id);
      if (!p) return { aplicado: false, motivo: 'order not found' };
      const alvo = { 'PAYMENT.AUTHORIZATION.CREATED': 'AUTHORIZED', 'PAYMENT.CAPTURE.PENDING': 'CAPTURE_PENDING', 'PAYMENT.CAPTURE.COMPLETED': 'CAPTURED', 'PAYMENT.CAPTURE.DECLINED': 'CAPTURE_DECLINED', 'PAYMENT.AUTHORIZATION.VOIDED': 'VOIDED' }[evento.event_type];
      if (!alvo) return { aplicado: false, motivo: 'event type ignored' };
      if ((RANK[alvo] ?? 0) <= (RANK[p.estado] ?? 0)) { this.#registrar(p, 'webhook ignored (backwards)', { evento: evento.event_type }); return { aplicado: false, motivo: 'backwards' }; }
      if (alvo === 'CAPTURED') {
        if (r.amount && (r.amount.value !== p.valor || r.amount.currency_code !== p.moeda)) { this.#alerta(p, 'webhook capture amount differs from the order; ignored'); return { aplicado: false, motivo: 'amount mismatch' }; }
        p.capture_id = r.id; p.contadores.capturas_ok = 1; delete p.incerto;
      }
      if (alvo === 'CAPTURE_PENDING' || alvo === 'CAPTURE_DECLINED') p.capture_id = r.id;
      p.estado = alvo;
      this.#registrar(p, 'webhook applied', { evento: evento.event_type });
      return { aplicado: true };
    } finally { this.#salvar(); }
  }
}
