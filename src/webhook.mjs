// PayPal webhook authenticity check, following PayPal's documented self-verification:
// message = transmissionId|transmissionTime|webhookId|crc32(raw body, decimal), verified with SHA256withRSA
// against the certificate at paypal-cert-url (https://developer.paypal.com/api/rest/webhooks/rest/).
// The certificate URL must be HTTPS on a paypal.com host; certificates are cached by URL.
import { crc32 } from 'node:zlib';
import { verify as rsaVerify, X509Certificate, createPublicKey } from 'node:crypto';

const header = (h, n) => h[n] ?? h[n.toLowerCase()] ?? h[n.toUpperCase()];

export function certUrlPermitida(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'paypal.com' || u.hostname.endsWith('.paypal.com'));
  } catch { return false; }
}

export function mensagemAssinada({ transmissionId, transmissionTime, webhookId, corpo }) {
  return `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(Buffer.from(corpo))}`;
}

/**
 * @param {object} o
 * @param {string} o.webhookId   id of our webhook subscription (configuration, not from the request)
 * @param {(url: string) => Promise<string>} o.buscarCert  returns the PEM certificate for a permitted URL
 * @param {number} [o.toleranciaMs]  max clock skew between transmission time and now
 */
export function criarVerificador({ webhookId, buscarCert, toleranciaMs = 15 * 60 * 1000, agora = () => Date.now() }) {
  if (!webhookId) throw new Error('PAYPAL_WEBHOOK_ID missing');
  const cache = new Map();
  return async function verificar(headers, corpo) {
    const transmissionId = header(headers, 'paypal-transmission-id');
    const transmissionTime = header(headers, 'paypal-transmission-time');
    const certUrl = header(headers, 'paypal-cert-url');
    const sig = header(headers, 'paypal-transmission-sig');
    const algo = header(headers, 'paypal-auth-algo');
    if (!transmissionId || !transmissionTime || !certUrl || !sig) return { ok: false, motivo: 'missing PayPal signature headers' };
    if (algo && algo !== 'SHA256withRSA') return { ok: false, motivo: `unsupported auth algorithm ${algo}` };
    if (!certUrlPermitida(certUrl)) return { ok: false, motivo: 'certificate URL is not an https paypal.com address' };
    const t = Date.parse(transmissionTime);
    if (!Number.isFinite(t) || Math.abs(agora() - t) > toleranciaMs) return { ok: false, motivo: 'transmission time outside the accepted window' };
    let pem = cache.get(certUrl);
    if (!pem) { pem = await buscarCert(certUrl); cache.set(certUrl, pem); }
    let chave;
    if (pem.includes('BEGIN CERTIFICATE')) {
      const cert = new X509Certificate(pem);
      if (Date.parse(cert.validTo) < agora()) return { ok: false, motivo: 'certificate expired' };
      chave = cert.publicKey;
    } else chave = createPublicKey(pem); // tests inject a bare public key; production always downloads a certificate
    const msg = mensagemAssinada({ transmissionId, transmissionTime, webhookId, corpo });
    const ok = rsaVerify('sha256', Buffer.from(msg), chave, Buffer.from(sig, 'base64'));
    return ok ? { ok: true, transmissionId } : { ok: false, motivo: 'signature does not match' };
  };
}

/** Production fetcher: downloads the certificate with a timeout, only from permitted URLs. */
export async function buscarCertHttps(url, timeoutMs = 10000) {
  if (!certUrlPermitida(url)) throw new Error('certificate URL not permitted');
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'error' });
    if (!r.ok) throw new Error(`certificate download returned ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}
