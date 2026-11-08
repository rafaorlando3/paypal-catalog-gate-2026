// Thin client for the PayPal REST subset (Orders v2 intent AUTHORIZE, Payments v2). Sandbox by default.
// Credentials come only from the environment; they are never logged.
export class PayPalRest {
  constructor({ clientId = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET, base = process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com', timeoutMs = 20000, retornoUrl } = {}) {
    if (!clientId || !secret) throw new Error('PAYPAL_CLIENT_ID e PAYPAL_CLIENT_SECRET ausentes');
    if (!/sandbox/.test(base) && process.env.PERMITIR_PRODUCAO !== 'sim') throw new Error('somente sandbox');
    Object.assign(this, { clientId, secret, base, timeoutMs, retornoUrl });
  }
  async #token() {
    if (this.tok && this.tok.exp > Date.now() + 60000) return this.tok.v;
    const r = await this.#http('/v1/oauth2/token', { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(`${this.clientId}:${this.secret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' }, false);
    this.tok = { v: r.access_token, exp: Date.now() + r.expires_in * 1000 };
    return this.tok.v;
  }
  async #http(path, init, auth = true) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const headers = { ...(init.headers || {}) };
    if (auth) headers.authorization = `Bearer ${await this.#token()}`;
    let r;
    try { r = await fetch(this.base + path, { ...init, headers, signal: ctrl.signal }); }
    catch (e) { const err = new Error(`sem resposta: ${e.name}`); err.incerto = true; throw err; }
    finally { clearTimeout(t); }
    const txt = await r.text(); let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { raw: txt.slice(0, 200) }; }
    if (r.status >= 500) { const err = new Error(`PayPal ${r.status}`); err.incerto = true; err.debug_id = j.debug_id; throw err; }
    if (r.status >= 400) { const err = new Error(`PayPal ${r.status} ${j.name || ''} ${j.details?.[0]?.issue || ''}`.trim()); err.status = r.status; err.debug_id = j.debug_id; throw err; }
    return j;
  }
  #post(path, body, requestId) {
    const headers = { 'content-type': 'application/json', prefer: 'return=representation' };
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    return this.#http(path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  }
  async criarPedido({ valor, moeda, requestId }) {
    const o = await this.#post('/v2/checkout/orders', {
      intent: 'AUTHORIZE',
      purchase_units: [{ amount: { currency_code: moeda, value: valor }, description: 'Catalog import acceptance (sandbox)' }],
      payment_source: this.retornoUrl ? { paypal: { experience_context: { return_url: this.retornoUrl, cancel_url: this.retornoUrl, user_action: 'CONTINUE' } } } : undefined,
    }, requestId);
    return { id: o.id, status: o.status, aprovacao_url: o.links?.find((l) => ['approve', 'payer-action'].includes(l.rel))?.href };
  }
  async autorizarPedido({ orderId, requestId }) {
    const o = await this.#post(`/v2/checkout/orders/${orderId}/authorize`, {}, requestId);
    return o.purchase_units?.[0]?.payments?.authorizations?.[0];
  }
  capturar({ autorizacaoId, payload, requestId }) { return this.#post(`/v2/payments/authorizations/${autorizacaoId}/capture`, payload, requestId); }
  obterAutorizacao(id) { return this.#http(`/v2/payments/authorizations/${id}`, { method: 'GET' }); }
  obterCaptura(id) { return this.#http(`/v2/payments/captures/${id}`, { method: 'GET' }); }
  reautorizar({ autorizacaoId, payload, requestId }) { return this.#post(`/v2/payments/authorizations/${autorizacaoId}/reauthorize`, payload, requestId); }
  anular({ autorizacaoId, requestId }) { return this.#post(`/v2/payments/authorizations/${autorizacaoId}/void`, {}, requestId); }
}
