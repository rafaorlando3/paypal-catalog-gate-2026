// In-memory stand-in for the PayPal REST subset used by R1. Labeled "fixture": it produces no PayPal receipt.
// Idempotency follows the documented rule: the same PayPal-Request-Id returns the latest state of the earlier request.
export class PayPalFixture {
  constructor(opcoes = {}) {
    this.o = { captura: 'COMPLETED', ...opcoes };
    this.seq = 0; this.porRequest = new Map(); this.aut = new Map(); this.cap = new Map(); this.posts = [];
  }
  #id(p) { return `${p}${++this.seq}`; }
  #idem(requestId, fn) {
    if (requestId && this.porRequest.has(requestId)) return structuredClone(this.porRequest.get(requestId)());
    const res = fn(); if (requestId) this.porRequest.set(requestId, res.latest); return structuredClone(res.body);
  }
  async criarPedido({ valor, moeda, requestId }) {
    return this.#idem(requestId, () => { const id = this.#id('O'); this.ordem = { id, valor, moeda }; const b = { id, status: 'CREATED', aprovacao_url: null }; return { body: b, latest: () => b }; });
  }
  async autorizarPedido({ orderId, requestId }) {
    return this.#idem(requestId, () => {
      const id = this.o.autId || this.#id('A');
      this.aut.set(id, { id, status: 'CREATED', amount: { currency_code: this.ordem.moeda, value: this.ordem.valor }, supplementary_data: { related_ids: { order_id: orderId } } });
      return { body: this.aut.get(id), latest: () => this.aut.get(id) };
    });
  }
  async capturar({ autorizacaoId, payload, requestId }) {
    this.posts.push({ op: 'capture', autorizacaoId, payload, requestId });
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
    if (this.o.cortarResposta) { const e = new Error('timeout'); e.incerto = true; throw e; }
    return body;
  }
  async obterAutorizacao(id) { const a = structuredClone(this.aut.get(id)); if (this.o.autStatus) a.status = this.o.autStatus; return a; }
  async obterCaptura(id) { const c = structuredClone(this.cap.get(id)); if (this.o.capturaGet) c.status = this.o.capturaGet; return c; }
  async reautorizar({ autorizacaoId, payload, requestId }) {
    this.posts.push({ op: 'reauthorize', autorizacaoId, requestId });
    return this.#idem(requestId, () => { const id = this.#id('A'); this.aut.set(id, { id, status: 'CREATED', amount: payload.amount, supplementary_data: { related_ids: {} } }); return { body: this.aut.get(id), latest: () => this.aut.get(id) }; });
  }
  async anular({ autorizacaoId, requestId }) {
    this.posts.push({ op: 'void', autorizacaoId, requestId });
    const a = this.aut.get(autorizacaoId); if (a.status === 'CAPTURED') { const e = new Error('AUTHORIZATION_ALREADY_CAPTURED'); e.status = 422; throw e; }
    a.status = 'VOIDED'; return structuredClone(a);
  }
}
