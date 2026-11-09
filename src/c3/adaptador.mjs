// AI adapter for C3 suggestions. OFF by default. No provider ships with C3: the model id and price are not
// verified and no AI key is authorized, so adaptadorDoAmbiente() is always disabled, whatever the environment says.
// A provider is a plain function injected by a later, separately reviewed increment (or by tests).
import { ESQUEMA_RESPOSTA, LIMITES } from './sugestoes.mjs';

export const IA_DESLIGADA = Object.freeze({ habilitado: false, motivo: 'AI suggestions are off: no provider ships with C3 (model id and price not verified, no AI key authorized)' });

/** Always disabled in C3. Environment variables cannot turn it on. */
export function adaptadorDoAmbiente() { return IA_DESLIGADA; }

/**
 * @param {object} o
 * @param {boolean} [o.habilitado=false]  must be exactly true
 * @param {(req: {prompt, esquema, modelo, temperatura, maxSaidaBytes, signal}) => Promise<string>} [o.provedor]
 * @param {string} [o.modelo]  exact model id, recorded with every answer
 * @param {number} [o.timeoutMs=15000]
 */
export function criarAdaptadorIA({ habilitado = false, provedor, modelo, timeoutMs = 15000, maxSaidaBytes = LIMITES.maxResposta } = {}) {
  if (habilitado !== true) return IA_DESLIGADA;
  if (typeof provedor !== 'function') throw new Error('an enabled AI adapter needs a provider function');
  if (typeof modelo !== 'string' || !/^[A-Za-z0-9._:\/-]{1,80}$/.test(modelo)) throw new Error('an enabled AI adapter needs an exact model id');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('timeoutMs must be 1..60000');
  return Object.freeze({
    habilitado: true, modelo, timeoutMs,
    async propor(prompt) {
      const ctrl = new AbortController(); let t;
      const prazo = new Promise((_, rej) => { t = setTimeout(() => { ctrl.abort(); rej(new Error('AI provider timeout')); }, timeoutMs); });
      try {
        const r = await Promise.race([provedor({ prompt, esquema: ESQUEMA_RESPOSTA, modelo, temperatura: 0, maxSaidaBytes, signal: ctrl.signal }), prazo]);
        if (typeof r !== 'string') throw new Error('AI provider returned no text');
        if (Buffer.byteLength(r) > maxSaidaBytes) throw new Error('AI provider answer too large');
        return r;
      } finally { clearTimeout(t); }
    },
  });
}
