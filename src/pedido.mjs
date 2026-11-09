// Order state machine for R1: authorize first, capture the full authorized amount only after a
// deterministic verdict plus an explicit human click. The model never enables capture.
// Every external call is journaled (intent, PayPal-Request-Id, payload hash, state) BEFORE it is sent;
// a lost answer or a restart leaves an operation-specific UNCERTAIN state. It is resolved by GET where a GET can
// settle it, otherwise it stays blocked with an alert for manual review. No POST is ever sent for an UNCERTAIN
// operation, not even by a human click: PayPal-Request-Id retention and per-endpoint replay are not qualified yet.
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

const RANK = { CREATED: 0, AUTHORIZED: 1, DELIVERED: 2, CHECKED: 3, CAPTURE_REQUESTED: 4, CAPTURE_PENDING: 5, CAPTURED: 9, CAPTURE_DECLINED: 9, VOIDED: 9, EXPIRED: 9 };
const VIVOS = ['AUTHORIZED', 'DELIVERED', 'CHECKED'];
const EM_VOO = { create: 'CREATE_REQUESTED', authorize: 'AUTHORIZE_REQUESTED', capture: 'CAPTURE_REQUESTED', void: 'VOID_REQUESTED', reauthorize: 'REAUTHORIZE_REQUESTED' };
const texto = (v) => typeof v === 'string' && v.length > 0;

export class Mesa {
  /**
   * @param {object} o
   * @param {object} o.paypal   client with the PayPal REST subset (sandbox REST or fixture)
   * @param {() => number} [o.agora]  clock in ms
   * @param {object} [o.brief]
   * @param {string} [o.amostra] approved sample lines (no header)
   * @param {object} [o.store]   persistence with ler() and gravar(estado); see store.mjs
   * @param {object} [o.limiteParecer] model-call cap: { porPedido, porDia }
   */
  constructor({ paypal, agora = () => Date.now(), brief, amostra, store = null, limiteParecer = { porPedido: 3, porDia: 50 } }) {
    Object.assign(this, { paypal, agora, brief, amostra, store, limiteParecer });
    this.pedidos = new Map();
    this.travas = new Map();
    this.eventos = new Set();
    this.uso = { dia: '', chamadas: 0 };
    this.log = [];
    if (store) this.#recuperar(store.ler());
  }

  // ---------- persistence and recovery ----------
  #recuperar(estado) {
    if (!estado) return;
    for (const p of estado.pedidos || []) this.pedidos.set(p.id, p);
    for (const e of estado.eventos || []) this.eventos.add(e);
    if (estado.uso) this.uso = estado.uso;
    for (const p of this.pedidos.values()) {
      const op = Object.keys(EM_VOO).find((k) => EM_VOO[k] === p.estado);
      if (op) {
        p.estado = 'UNCERTAIN'; p.incerto = op;
        this.#alerta(p, `Restart while a ${op} request was in flight. Reconcile with PayPal before any other action.`);
      }
    }
    this.#salvar();
  }

  #salvar() {
    if (this.store) this.store.gravar({ versao: 1, pedidos: [...this.pedidos.values()], eventos: [...this.eventos], uso: this.uso });
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

  avisos(id) {
    const p = this.pedido(id);
    const out = [];
    if (p.estado === 'EXPIRED') out.push('Authorization expired: a new authorization needs a new order.');
    else if (p.autorizacao_id && this.#diasAutAtual(p) >= 3 && [...VIVOS, 'REDELIVERY'].includes(p.estado)) out.push('Honor period over: the capture may fail. Reauthorizing needs a human click (once, from day 4 to day 29).');
    return out;
  }

  // ---------- journaled external calls ----------
  /** Records request id and payload hash; the same id with another payload is blocked locally. */
  #preparar(p, op, payload, ...chave) {
    const requestId = requestIdDe(p.id, op, ...chave);
    const hash = sha256(canonico(payload));
    const antes = p.requisicoes[requestId];
    if (antes && antes.hash !== hash) {
      this.#alerta(p, `same PayPal-Request-Id with a different payload for ${op}; nothing was sent`);
      throw new ErroRegra('REQUEST_ID_PAYLOAD_MISMATCH', `${op} ${requestId.slice(0, 8)}`);
    }
    p.requisicoes[requestId] = { op, hash, payload, chave };
    return requestId;
  }

  /**
   * Persists the intent and the in-flight state, then calls PayPal.
   * Lost answer: UNCERTAIN(op). Definitive refusal: onRecusa(error). Success: onOk(result).
   */
  async #chamar(p, op, payload, chave, enviar, onOk, onRecusa) {
    const requestId = this.#preparar(p, op, payload, ...chave);
    p.pendente = { op, requestId, estado_anterior: p.estado, em: new Date(this.agora()).toISOString() };
    p.estado = EM_VOO[op];
    this.#registrar(p, `${op} requested`, { requestId: requestId.slice(0, 8) });
    this.#salvar(); // intent is durable before the request leaves
    let r;
    try { r = await enviar(requestId); } catch (e) {
      if (e.incerto) { p.estado = 'UNCERTAIN'; p.incerto = op; this.#registrar(p, `no answer from PayPal for ${op}`, { motivo: e.message }); return p; }
      const anterior = p.pendente.estado_anterior; delete p.pendente;
      onRecusa(e, anterior); return p;
    }
    delete p.pendente;
    onOk(r); return p;
  }

  async criar({ id, valor = '50.00', moeda = 'USD', dono = null }) {
    if (this.pedidos.has(id)) throw new ErroRegra('ORDER_EXISTS', id);
    const p = { id, dono, valor, moeda, estado: 'NEW', trilha: [], alertas: [], requisicoes: {}, contadores: { posts_capture: 0, posts_void: 0, posts_reauth: 0, capturas_ok: 0, pareceres: 0 }, reentregas: 0, reautorizacoes: 0, autorizacoes_substituidas: [] };
    this.pedidos.set(id, p);
    return this.#trava(id, () => this.#chamar(p, 'create', { valor, moeda }, [],
      (rid) => this.paypal.criarPedido({ valor, moeda, requestId: rid }),
      (o) => { p.order_id = o.id; p.aprovacao_url = o.aprovacao_url; p.estado = 'CREATED'; this.#registrar(p, 'PayPal order created', { order_id: o.id }); },
      (e) => { p.estado = 'CREATE_FAILED'; this.#registrar(p, 'PayPal refused the order', { motivo: e.message }); }));
  }

  /** After the buyer approved the order in PayPal: authorize it (funds held, not captured). */
  async autorizar(id) {
    return this.#trava(id, async () => {
      const p = this.pedido(id);
      if (p.estado !== 'CREATED') throw new ErroRegra('STATE', `authorize needs CREATED, order is ${p.estado}`);
      return this.#chamar(p, 'authorize', { order_id: p.order_id }, [p.order_id],
        (rid) => this.paypal.autorizarPedido({ orderId: p.order_id, requestId: rid }),
        (a) => this.#aplicarAutorizacao(p, a),
        (e, ant) => { p.estado = ant; this.#registrar(p, 'authorization refused by PayPal', { motivo: e.message }); });
    });
  }

  #aplicarAutorizacao(p, a) {
    if (!texto(a?.id)) { p.estado = 'UNCERTAIN'; p.incerto = 'authorize'; this.#alerta(p, 'PayPal returned no authorization id'); return; }
    p.autorizacao_id = a.id; p.autorizacao_original = a.id;
    p.autorizado_em = this.agora(); p.aut_atual_em = this.agora();
    p.estado = 'AUTHORIZED'; delete p.incerto;
    this.#registrar(p, 'authorized', { authorization_id: a.id, status: a.status });
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

  /** Advisory text from a model, under a per-order and per-day cap. It can never enable or block capture. */
  async parecer(id, gerar) {
    const p = this.pedido(id);
    if (!p.relatorio) throw new ErroRegra('STATE', 'an advisory needs a check report');
    const hoje = new Date(this.agora()).toISOString().slice(0, 10);
    if (this.uso.dia !== hoje) this.uso = { dia: hoje, chamadas: 0 };
    p.contadores.pareceres ??= 0;
    if (p.contadores.pareceres >= this.limiteParecer.porPedido || this.uso.chamadas >= this.limiteParecer.porDia) {
      p.parecer = { estado: 'unavailable', texto: 'Advisory unavailable', motivo: 'advisory budget reached' };
      this.#registrar(p, 'advisory skipped: budget reached'); this.#salvar();
      return p.parecer;
    }
    p.contadores.pareceres++; this.uso.chamadas++; this.#salvar(); // counted before the call
    let resposta;
    try { resposta = await gerar(p.relatorio, this.brief); } catch (e) {
      p.parecer = { estado: 'unavailable', texto: 'Advisory unavailable', motivo: String(e.message || e) };
      this.#registrar(p, 'advisory unavailable', { motivo: p.parecer.motivo });
      this.#salvar();
      return p.parecer;
    }
    const chk = checarParecer(resposta, p.relatorio);
    p.parecer = chk.ok ? { estado: 'accepted', texto: resposta, rotulo: 'advisory, not a decision' } : { estado: 'rejected', texto: resposta, motivo: chk.motivo, rotulo: 'advisory rejected by the checker' };
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

  /** The full authorized amount, stated explicitly, with final_capture: true (no partial capture). */
  payloadCaptura(p) { return { amount: { currency_code: p.moeda, value: p.valor }, final_capture: true }; }

  async capturar(id, { humano = false, li_rejeicoes = false } = {}) {
    if (!humano) throw new ErroRegra('NO_HUMAN_CLICK', 'capture needs a human click');
    return this.#trava(id, async () => {
      const p = this.pedido(id);
      const [ok, motivo] = this.podeCapturar(p, { li_rejeicoes });
      if (!ok) { this.#registrar(p, 'capture refused locally', { motivo }); return p; }
      p.contadores.posts_capture++;
      return this.#chamar(p, 'capture', this.payloadCaptura(p), [p.autorizacao_id],
        (rid) => this.paypal.capturar({ autorizacaoId: p.autorizacao_id, payload: this.payloadCaptura(p), requestId: rid }),
        (r) => this.#aplicarCaptura(p, r),
        (e) => { p.estado = 'CAPTURE_DECLINED'; this.#registrar(p, 'capture refused by PayPal', { motivo: e.message }); });
    });
  }

  /** A retry of a capture whose answer was lost. Never sends: reconciliation is by GET only. */
  async repetirCaptura(id, payload) {
    return this.#trava(id, async () => {
      const p = this.pedido(id);
      this.#preparar(p, 'capture', payload ?? this.payloadCaptura(p), p.autorizacao_id); // divergent payload is reported first
      throw new ErroRegra('CAPTURE_BLOCKED', `invariant 8: ${p.estado}${p.capture_id ? ' with capture id' : ''}; reconcile by GET`);
    });
  }

  #aplicarCaptura(p, r) {
    if (r.status === 'COMPLETED') {
      p.capture_id = r.id; p.estado = 'CAPTURED'; p.contadores.capturas_ok = 1; delete p.incerto;
      this.#registrar(p, 'captured', { capture_id: r.id });
    } else if (r.status === 'PENDING') {
      p.capture_id = r.id; p.estado = 'CAPTURE_PENDING'; delete p.incerto;
      this.#registrar(p, 'capture pending (not received)', { capture_id: r.id });
    } else {
      p.capture_id = r.id; p.estado = 'CAPTURE_DECLINED'; delete p.incerto;
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
      if (p.estado === 'UNCERTAIN') {
        switch (p.incerto) {
          case 'capture': {
            const a = await this.paypal.obterAutorizacao(p.autorizacao_id);
            const k = a.supplementary_data?.related_ids?.capture_id;
            if (a.status === 'CAPTURED' && texto(k)) {
              const c = await this.paypal.obterCaptura(k);
              if (['COMPLETED', 'PENDING'].includes(c.status) && this.#confere(p, c)) return this.#aplicarCaptura(p, c);
            }
            if (a.status === 'CREATED' && !k) { this.#alerta(p, 'PayPal shows the authorization still open. Blocked for manual review; nothing is sent.'); return p; }
            this.#alerta(p, 'probable capture without a verifiable link; capture, void and reauthorization stay blocked until a person reviews');
            return p;
          }
          case 'authorize': {
            if (!texto(p.order_id)) break;
            const o = await this.paypal.obterPedido(p.order_id);
            const auts = o.purchase_units?.[0]?.payments?.authorizations || [];
            if (auts.length === 1 && texto(auts[0].id)) { delete p.pendente; this.#aplicarAutorizacao(p, auts[0]); return p; }
            this.#alerta(p, `order ${p.order_id} shows ${auts.length} authorizations; blocked for manual review, nothing is sent`);
            return p;
          }
          case 'void': {
            const a = await this.paypal.obterAutorizacao(p.autorizacao_id);
            if (a.status === 'VOIDED') { delete p.pendente; p.estado = 'VOIDED'; delete p.incerto; this.#registrar(p, 'voided (confirmed by GET)'); return p; }
            this.#alerta(p, `void not confirmed: PayPal shows ${a.status}. Blocked for manual review; nothing is sent.`);
            return p;
          }
          case 'divergence':
          default:
            break;
        }
        this.#alerta(p, `uncertain ${p.incerto}: no GET can settle it; blocked for manual review, nothing is sent`);
        return p;
      }
      if (VIVOS.includes(p.estado) && texto(p.autorizacao_id)) {
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
      p.contadores.posts_void++;
      return this.#chamar(p, 'void', {}, [p.autorizacao_id],
        (rid) => this.paypal.anular({ autorizacaoId: p.autorizacao_id, requestId: rid }),
        () => { p.estado = 'VOIDED'; this.#registrar(p, 'voided'); },
        (e, ant) => { p.estado = ant; this.#registrar(p, 'void refused by PayPal', { motivo: e.message }); });
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
      p.contadores.posts_reauth++;
      return this.#chamar(p, 'reauthorize', payload, [p.autorizacao_id],
        (rid) => this.paypal.reautorizar({ autorizacaoId: p.autorizacao_id, payload, requestId: rid }),
        (a) => this.#aplicarReautorizacao(p, a),
        (e, ant) => { p.estado = ant; this.#registrar(p, 'reauthorization refused by PayPal', { motivo: e.message }); });
    });
  }

  #aplicarReautorizacao(p, a) {
    if (!texto(a?.id)) { p.estado = 'UNCERTAIN'; p.incerto = 'reauthorize'; this.#alerta(p, 'PayPal returned no authorization id on reauthorize'); return; }
    const anterior = p.pendente?.estado_anterior;
    p.autorizacoes_substituidas.push(p.autorizacao_id);
    p.autorizacao_id = a.id; p.aut_atual_em = this.agora(); p.reautorizacoes++;
    p.estado = VIVOS.includes(anterior) ? anterior : (p.relatorio ? 'CHECKED' : p.lote ? 'DELIVERED' : 'AUTHORIZED');
    this.#registrar(p, 'reauthorized', { authorization_id: a.id });
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
   * matched only on present, known ids, applied forward only. Insufficient evidence marks the order
   * for GET reconciliation instead of changing it. Event names: https://developer.paypal.com/api/rest/webhooks/event-names/
   */
  webhook(evento) {
    if (!texto(evento?.id)) return { aplicado: false, motivo: 'event without id' };
    if (this.eventos.has(evento.id)) return { aplicado: false, motivo: 'duplicate' };
    const r = this.#webhookInterno(evento);
    // Only settled outcomes are deduplicated; an event that could not be matched yet may be redelivered by PayPal later.
    if (r.aplicado || ['backwards', 'event type ignored'].includes(r.motivo)) this.eventos.add(evento.id);
    this.#salvar();
    return r;
  }

  #webhookInterno(evento) {
    {
      const tipo = evento.event_type;
      const r = evento.resource || {};
      const ehCaptura = tipo?.startsWith('PAYMENT.CAPTURE.');
      const ehAutorizacao = tipo?.startsWith('PAYMENT.AUTHORIZATION.');
      const alvo = { 'PAYMENT.AUTHORIZATION.CREATED': 'AUTHORIZED', 'PAYMENT.CAPTURE.PENDING': 'CAPTURE_PENDING', 'PAYMENT.CAPTURE.COMPLETED': 'CAPTURED', 'PAYMENT.CAPTURE.DECLINED': 'CAPTURE_DECLINED', 'PAYMENT.AUTHORIZATION.VOIDED': 'VOIDED' }[tipo];
      if (!alvo) return { aplicado: false, motivo: 'event type ignored' };
      const autId = ehCaptura ? r.supplementary_data?.related_ids?.authorization_id : ehAutorizacao ? r.id : undefined;
      if (!texto(autId)) return { aplicado: false, motivo: 'no authorization id in the event' };
      const p = [...this.pedidos.values()].find((x) => texto(x.autorizacao_id) && x.autorizacao_id === autId);
      if (!p) return { aplicado: false, motivo: 'unknown authorization' };
      if (ehCaptura) {
        if (texto(r.id) && r.amount && (r.amount.value !== p.valor || r.amount.currency_code !== p.moeda)) {
          p.precisa_get = true;
          this.#alerta(p, `webhook ${tipo} amount ${r.amount.currency_code} ${r.amount.value} differs from the order; reconcile by GET`);
          return { aplicado: false, motivo: 'amount mismatch' };
        }
        if (!texto(r.id) || !r.amount) {
          p.precisa_get = true;
          this.#alerta(p, `webhook ${tipo} lacks a capture id or the exact amount; reconcile by GET`);
          return { aplicado: false, motivo: 'insufficient evidence; reconcile by GET' };
        }
        if (texto(p.capture_id) && p.capture_id !== r.id) {
          p.precisa_get = true;
          this.#alerta(p, `webhook capture ${r.id} differs from recorded capture ${p.capture_id}; reconcile by GET`);
          return { aplicado: false, motivo: 'capture id differs; reconcile by GET' };
        }
      }
      if (p.estado === 'UNCERTAIN') {
        const resolve = (p.incerto === 'capture' && ehCaptura) || (p.incerto === 'void' && alvo === 'VOIDED');
        if (!resolve) { p.precisa_get = true; this.#alerta(p, `webhook ${tipo} does not settle the uncertain ${p.incerto}; reconcile by GET`); return { aplicado: false, motivo: 'order uncertain; reconcile by GET' }; }
      } else if ((RANK[alvo] ?? 0) <= (RANK[p.estado] ?? 0)) { this.#registrar(p, 'webhook ignored (backwards)', { evento: tipo }); return { aplicado: false, motivo: 'backwards' }; }
      if (ehCaptura) p.capture_id = r.id;
      if (alvo === 'CAPTURED') { p.contadores.capturas_ok = 1; }
      delete p.incerto; delete p.pendente;
      p.estado = alvo;
      this.#registrar(p, 'webhook applied', { evento: tipo });
      return { aplicado: true };
    }
  }
}
