// In-memory stand-in for the PayPal REST subset used by R1. Labeled "fixture": it produces no PayPal receipt.
// Idempotency follows the documented rule: the same PayPal-Request-Id returns the latest state of the earlier request.
// `posts` logs the money-moving POSTs (capture, void, reauthorize); `chamadas` logs every POST including create and authorize.
// Option `cortar`: list of operations whose request is processed but whose answer is lost (timeout).
export class PayPalFixture {
  constructor(opcoes = {}) {
    this.o = { captura: 'COMPLETED', cortar: [], ...opcoes };
    if (this.o.cortarResposta) this.o.cortar = [...this.o.cortar, 'capture'];
    this.seq = 0; this.porRequest = new Map(); this.ordens = new Map(); this.aut = new Map(); this.cap = new Map(); this.posts = []; this.chamadas = [];
  }
  #id(p) { return `${p}${++this.seq}`; }
  #idem(requestId, fn) {
    if (requestId && this.porRequest.has(requestId)) return structuredClone(this.porRequest.get(requestId)());
    const res = fn(); if (requestId) this.porRequest.set(requestId, res.latest); return structuredClone(res.body);
  }
  #cortar(op) { if (this.o.cortar.includes(op)) { const e = new Error('timeout'); e.incerto = true; throw e; } }
  async criarPedido({ valor, moeda, requestId }) {
    this.chamadas.push({ op: 'create', requestId });
    const b = this.#idem(requestId, () => {
      const id = this.#id('O'); const o = { id, status: 'APPROVED', valor, moeda, autorizacoes: [] }; this.ordens.set(id, o);
      return { body: { id, status: 'CREATED', aprovacao_url: null }, latest: () => ({ id, status: o.status, aprovacao_url: null }) };
    });
    this.#cortar('create');
    return b;
  }
  async autorizarPedido({ orderId, requestId }) {
    this.chamadas.push({ op: 'authorize', orderId, requestId });
    const b = this.#idem(requestId, () => {
      const o = this.ordens.get(orderId);
      const id = this.o.autId || this.#id('A');
      this.aut.set(id, { id, status: 'CREATED', amount: { currency_code: o.moeda, value: o.valor }, supplementary_data: { related_ids: { order_id: orderId } } });
      o.autorizacoes.push(id); o.status = 'COMPLETED';
      return { body: this.aut.get(id), latest: () => this.aut.get(id) };
    });
    this.#cortar('authorize');
    return b;
  }
  async obterPedido(orderId) {
    const o = this.ordens.get(orderId);
    return { id: o.id, status: o.status, purchase_units: [{ payments: { authorizations: o.autorizacoes.map((a) => structuredClone(this.aut.get(a))) } }] };
  }
  async capturar({ autorizacaoId, payload, requestId }) {
    this.posts.push({ op: 'capture', autorizacaoId, payload, requestId }); this.chamadas.push(this.posts.at(-1));
    if (this.o.atrasoMs) await new Promise((r) => setTimeout(r, this.o.atrasoMs));
    const body = this.#idem(requestId, () => {
      const a = this.aut.get(autorizacaoId);
      const id = this.o.capId || this.#id('K');
      const status = this.o.captura;
      const c = { id, status, amount: payload.amount || a.amount, final_capture: !!payload.final_capture, supplementary_data: { related_ids: { authorization_id: autorizacaoId } } };
      this.cap.set(id, c);
      if (status === 'COMPLETED' || status === 'PENDING') { a.status = 'CAPTURED'; if (!this.o.semVinculo) a.supplementary_data.related_ids.capture_id = id; }
      return { body: c, latest: () => this.cap.get(id) };
    });
    this.#cortar('capture');
    return body;
  }
  async obterAutorizacao(id) { const a = structuredClone(this.aut.get(id)); if (this.o.autStatus) a.status = this.o.autStatus; return a; }
  async obterCaptura(id) { const c = structuredClone(this.cap.get(id)); if (this.o.capturaGet) c.status = this.o.capturaGet; return c; }
  async reautorizar({ autorizacaoId, payload, requestId }) {
    this.posts.push({ op: 'reauthorize', autorizacaoId, requestId }); this.chamadas.push(this.posts.at(-1));
    const b = this.#idem(requestId, () => { const id = this.#id('A'); this.aut.set(id, { id, status: 'CREATED', amount: payload.amount, supplementary_data: { related_ids: {} } }); return { body: this.aut.get(id), latest: () => this.aut.get(id) }; });
    this.#cortar('reauthorize');
    return b;
  }
  async anular({ autorizacaoId, requestId }) {
    this.posts.push({ op: 'void', autorizacaoId, requestId }); this.chamadas.push(this.posts.at(-1));
    const b = this.#idem(requestId, () => {
      const a = this.aut.get(autorizacaoId); if (a.status === 'CAPTURED') { const e = new Error('AUTHORIZATION_ALREADY_CAPTURED'); e.status = 422; throw e; }
      a.status = 'VOIDED'; return { body: a, latest: () => this.aut.get(autorizacaoId) };
    });
    this.#cortar('void');
    return b;
  }
}
