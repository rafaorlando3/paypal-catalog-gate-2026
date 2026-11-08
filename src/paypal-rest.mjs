// Thin client for the PayPal REST subset (Orders v2 intent AUTHORIZE, Payments v2). SANDBOX ONLY.
// The origin is fixed to https://api-m.sandbox.paypal.com: there is no production switch and no base override.
// Redirects are refused (redirect: 'error'), so credentials and bearer tokens are only ever sent to that origin.
// Credentials come only from the environment; they are never logged.
export const SANDBOX_ORIGIN = 'https://api-m.sandbox.paypal.com';
const ID = /^[A-Za-z0-9-]{1,64}$/;
const seguro = (id) => { if (typeof id !== 'string' || !ID.test(id)) throw new Error('invalid PayPal resource id'); return id; };

export class PayPalRest {
  constructor({ clientId = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET, timeoutMs = 20000, retornoUrl, fetchImpl = globalThis.fetch, ...resto } = {}) {
    if ('base' in resto || (process.env.PAYPAL_BASE && process.env.PAYPAL_BASE !== SANDBOX_ORIGIN)) throw new Error(`only ${SANDBOX_ORIGIN} is allowed`);
    if (!clientId || !secret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET missing');
    Object.assign(this, { clientId, secret, timeoutMs, retornoUrl, fetchImpl });
  }
  get base() { return SANDBOX_ORIGIN; }
  async #token() {
    if (this.tok && this.tok.exp > Date.now() + 60000) return this.tok.v;
    const r = await this.#http('/v1/oauth2/token', { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(`${this.clientId}:${this.secret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' }, false);
    this.tok = { v: r.access_token, exp: Date.now() + r.expires_in * 1000 };
    return this.tok.v;
  }
  async #http(path, init, auth = true) {
    const url = new URL(path, SANDBOX_ORIGIN);
    if (url.origin !== SANDBOX_ORIGIN) throw new Error('refusing a request outside the sandbox origin');
    const headers = { ...(init.headers || {}) };
    if (auth) headers.authorization = `Bearer ${await this.#token()}`; // before the timer, so a failed token call leaves no timer behind
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let r;
    try { r = await this.fetchImpl(url.href, { ...init, headers, signal: ctrl.signal, redirect: 'error' }); }
    catch (e) { const err = new Error(`no response: ${e.name}`); err.incerto = true; throw err; }
    finally { clearTimeout(t); }
    const txt = await r.text(); let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { raw: txt.slice(0, 200) }; }
    if (r.status >= 500) { const err = new Error(`PayPal ${r.status}`); err.incerto = true; err.debug_id = j.debug_id; throw err; }
    if (r.status >= 300) { const err = new Error(`PayPal ${r.status} ${j.name || ''} ${j.details?.[0]?.issue || ''}`.trim()); err.status = r.status; err.debug_id = j.debug_id; throw err; }
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
    const o = await this.#post(`/v2/checkout/orders/${seguro(orderId)}/authorize`, {}, requestId);
    return o.purchase_units?.[0]?.payments?.authorizations?.[0];
  }
  async obterPedido(orderId) { return this.#http(`/v2/checkout/orders/${seguro(orderId)}`, { method: 'GET' }); }
  async capturar({ autorizacaoId, payload, requestId }) { return this.#post(`/v2/payments/authorizations/${seguro(autorizacaoId)}/capture`, payload, requestId); }
  async obterAutorizacao(id) { return this.#http(`/v2/payments/authorizations/${seguro(id)}`, { method: 'GET' }); }
  async obterCaptura(id) { return this.#http(`/v2/payments/captures/${seguro(id)}`, { method: 'GET' }); }
  async reautorizar({ autorizacaoId, payload, requestId }) { return this.#post(`/v2/payments/authorizations/${seguro(autorizacaoId)}/reauthorize`, payload, requestId); }
  async anular({ autorizacaoId, requestId }) { return this.#post(`/v2/payments/authorizations/${seguro(autorizacaoId)}/void`, {}, requestId); }
}
