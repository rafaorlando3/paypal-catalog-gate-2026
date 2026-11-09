// Thin client for the PayPal REST subset (Orders v2 intent AUTHORIZE, Payments v2). SANDBOX ONLY.
// The origin is fixed to https://api-m.sandbox.paypal.com: there is no production switch and no base override.
// Redirects are refused (redirect: 'error'), so credentials and bearer tokens are only ever sent to that origin.
// Credentials come only from the environment; they are never logged.
export const SANDBOX_ORIGIN = 'https://api-m.sandbox.paypal.com';
const ID = /^[A-Za-z0-9-]{1,64}$/;
const naoEnviado = (msg) => { const e = new Error(msg); e.naoEnviado = true; return e; };
const seguro = (id) => { if (typeof id !== 'string' || !ID.test(id)) throw naoEnviado('invalid PayPal resource id'); return id; };
// 4xx answers that do not prove the request had no effect; treated as uncertain (fail-closed).
const QUATRO_INCERTOS = [408, 409];

export class PayPalRest {
  constructor({ clientId = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET, timeoutMs = 20000, retornoUrl, fetchImpl = globalThis.fetch, ...resto } = {}) {
    if ('base' in resto || (process.env.PAYPAL_BASE && process.env.PAYPAL_BASE !== SANDBOX_ORIGIN)) throw new Error(`only ${SANDBOX_ORIGIN} is allowed`);
    if (!clientId || !secret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET missing');
    Object.assign(this, { clientId, secret, timeoutMs, retornoUrl, fetchImpl });
  }
  get base() { return SANDBOX_ORIGIN; }
  async #token() {
    if (this.tok && this.tok.exp > Date.now() + 60000) return this.tok.v;
    const r = await this.#json('/v1/oauth2/token', { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(`${this.clientId}:${this.secret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' }, false);
    if (typeof r.access_token !== 'string' || !r.access_token || !Number.isFinite(r.expires_in)) throw new Error('token answer without access_token or expires_in');
    this.tok = { v: r.access_token, exp: Date.now() + r.expires_in * 1000 };
    return this.tok.v;
  }
  /**
   * One HTTP exchange, headers AND full body under the same timeout and the same catch.
   * Anything short of a complete, well-formed answer is uncertain (err.incerto = true): the request may have executed.
   * Only a complete 4xx answer (except 408/409) is a definitive refusal (err.status). Errors raised before anything is
   * sent carry err.naoEnviado = true. Returns { http, vazio, corpo }.
   */
  async #http(path, init, auth = true) {
    const url = new URL(path, SANDBOX_ORIGIN);
    if (url.origin !== SANDBOX_ORIGIN) throw naoEnviado('refusing a request outside the sandbox origin');
    const headers = { ...(init.headers || {}) };
    if (auth) {
      try { headers.authorization = `Bearer ${await this.#token()}`; } // before the timer, so a failed token call leaves no timer behind
      catch (e) { const err = new Error(`no access token: ${e.message}`); err.naoEnviado = true; throw err; }
    }
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let r, txt;
    try {
      r = await this.fetchImpl(url.href, { ...init, headers, signal: ctrl.signal, redirect: 'error' });
      txt = await r.text(); // the body is part of the answer: same timeout, same catch
    } catch (e) {
      const err = new Error(`no complete answer${r ? ` after HTTP ${r.status} headers` : ''}: ${e.name}`); err.incerto = true; throw err;
    } finally { clearTimeout(t); }
    let corpo = null;
    if (txt) { try { corpo = JSON.parse(txt); } catch { corpo = undefined; } }
    const objeto = corpo !== null && typeof corpo === 'object' && !Array.isArray(corpo);
    const st = r.status;
    if (st >= 400 && st < 500 && !QUATRO_INCERTOS.includes(st)) {
      const err = new Error(`PayPal ${st} ${objeto ? `${corpo.name || ''} ${corpo.details?.[0]?.issue || ''}` : ''}`.trim()); err.status = st; err.debug_id = objeto ? corpo.debug_id : undefined; throw err;
    }
    if (st < 200 || st > 299) { const err = new Error(`PayPal ${st}`); err.incerto = true; err.debug_id = objeto ? corpo.debug_id : undefined; throw err; }
    if (txt && !objeto) { const err = new Error(`PayPal ${st} with a body that is not a JSON object`); err.incerto = true; throw err; }
    return { http: st, vazio: !txt, corpo: objeto ? corpo : {} };
  }
  async #json(path, init, auth = true) { return (await this.#http(path, init, auth)).corpo; }
  async #post(path, body, requestId) {
    const headers = { 'content-type': 'application/json', prefer: 'return=representation' };
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    return this.#http(path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  }
  async criarPedido({ valor, moeda, requestId }) {
    const { corpo: o } = await this.#post('/v2/checkout/orders', {
      intent: 'AUTHORIZE',
      purchase_units: [{ amount: { currency_code: moeda, value: valor }, description: 'Catalog import acceptance (sandbox)' }],
      payment_source: this.retornoUrl ? { paypal: { experience_context: { return_url: this.retornoUrl, cancel_url: this.retornoUrl, user_action: 'CONTINUE' } } } : undefined,
    }, requestId);
    return { id: o.id, status: o.status, aprovacao_url: Array.isArray(o.links) ? o.links.find((l) => ['approve', 'payer-action'].includes(l?.rel))?.href : undefined };
  }
  async autorizarPedido({ orderId, requestId }) {
    const { corpo: o } = await this.#post(`/v2/checkout/orders/${seguro(orderId)}/authorize`, {}, requestId);
    const auts = o.purchase_units?.[0]?.payments?.authorizations;
    return Array.isArray(auts) && auts.length === 1 ? auts[0] : undefined; // zero or several: not enough evidence
  }
  async obterPedido(orderId) { return this.#json(`/v2/checkout/orders/${seguro(orderId)}`, { method: 'GET' }); }
  async capturar({ autorizacaoId, payload, requestId }) { return (await this.#post(`/v2/payments/authorizations/${seguro(autorizacaoId)}/capture`, payload, requestId)).corpo; }
  async obterAutorizacao(id) { return this.#json(`/v2/payments/authorizations/${seguro(id)}`, { method: 'GET' }); }
  async obterCaptura(id) { return this.#json(`/v2/payments/captures/${seguro(id)}`, { method: 'GET' }); }
  async reautorizar({ autorizacaoId, payload, requestId }) { return (await this.#post(`/v2/payments/authorizations/${seguro(autorizacaoId)}/reauthorize`, payload, requestId)).corpo; }
  /** Void answers 204 with no body, or a representation. An empty answer is returned as { vazio: true, http }. */
  async anular({ autorizacaoId, requestId }) {
    const r = await this.#post(`/v2/payments/authorizations/${seguro(autorizacaoId)}/void`, {}, requestId);
    return r.vazio ? { vazio: true, http: r.http } : r.corpo;
  }
}
