// Baseline B1: a reasonable deterministic fixer, frozen before the reserved set exists.
// Rules, in order. Anything not covered asks the supplier. It never converts or strips a currency and never
// rebuilds a split CSV line unless the structure proves there is no other reading.
import { lerNumeroPorExtenso } from './numeros.mjs';

const DEC = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/;
const INT = /^(?:0|[1-9][0-9]*)$/;
export const MOEDA = /(?:US\$|R\$|\bUSD\b|\bBRL\b|\bPYG\b|\bARS\b|\bEUR\b|\bGs\b\.?|₲|€|\$|\breais?\b|\bpesos?\b|\bguaran[ií]es\b|\bd[oó]lar(?:es)?\b)/i;
const UNIDADE = /^(.*?)\s*(?:unidades|unidad|unid\.?|uds\.?|ud\.?|und\.?|u\.|un\.|piezas|pieza|pzas?\.?|pe[cç]as|pe[cç]a)$/i;

export function passaCampo(col, v) {
  if (v === '' || v === undefined) return false;
  if (col.regex && !new RegExp(col.regex).test(v)) return false;
  if (col.tipo === 'decimal_positivo') return DEC.test(v) && Number(v) > 0;
  if (col.tipo === 'inteiro_nao_negativo') return INT.test(v);
  return true;
}

const pedir = (motivo) => ({ acao: 'pedir_ao_fornecedor', valor: null, motivo });
const corrigir = (valor, regra) => ({ acao: 'corrigir', valor, motivo: regra });

/** Rebuilds a line with one extra column only when splitting precio is the single valid reading. */
export function recombinarDecimal(linha, brief) {
  const c = linha.split(',');
  const nomes = brief.colunas.map((x) => x.nome);
  if (c.length !== nomes.length + 1 || nomes.join(',') !== 'sku,nombre,precio,stock') return null;
  const col = Object.fromEntries(brief.colunas.map((x) => [x.nome, x]));
  const [sku, nombre, a, b, stock] = c;
  const lidaPreco = /^[0-9]+$/.test(a) && /^[0-9]{1,2}$/.test(b) ? `${a}.${b}` : null;
  const viavelPreco = lidaPreco && passaCampo(col.sku, sku) && nombre !== '' && passaCampo(col.precio, lidaPreco) && passaCampo(col.stock, stock);
  const viavelNome = passaCampo(col.sku, sku) && `${nombre},${a}` !== '' && passaCampo(col.precio, b) && passaCampo(col.stock, stock);
  if (viavelPreco && !viavelNome) return [sku, nombre, lidaPreco, stock].join(',');
  return null; // no valid reading, or more than one
}

/**
 * @param {object} achado  from extrairAchados
 * @param {object} ctx     { brief, chaves: Set of skus present in the lot }
 * @returns {{acao: 'corrigir'|'pedir_ao_fornecedor', valor: string|null, motivo: string}}
 */
export function propostaB1(achado, { brief, chaves = new Set() }) {
  const col = brief.colunas.find((c) => c.nome === achado.campo);
  if (achado.tipo === 'cabecalho') return pedir('header must match the brief exactly');
  if (achado.tipo === 'duplicata') return pedir('duplicate key: only the supplier knows which row is right');
  if (achado.tipo === 'amostra') return passaCampo(col, achado.esperado) ? corrigir(achado.esperado, 'approved sample value') : pedir('approved sample value does not pass the brief');
  if (MOEDA.test(achado.original)) return pedir('currency marker: amount must be restated in the agreed format; no conversion');
  if (achado.campo === '*') {
    const l = recombinarDecimal(achado.original, brief);
    return l ? corrigir(l, 'decimal comma split the line; only one valid reading') : pedir('line has an extra column and more than one reading (or none)');
  }
  if (!col) return pedir('unknown field');
  const v = achado.original;
  if (v.trim() === '') return pedir('required value is empty');
  const t = v.trim();
  if (t !== v && passaCampo(col, t) && !(col.nome === brief.chave && chaves.has(t))) return corrigir(t, 'surrounding spaces removed');
  if (col.nome === 'sku') {
    const u = t.toUpperCase();
    if (u !== t && passaCampo(col, u) && !chaves.has(u)) return corrigir(u, 'sku upper-cased; no other row has it');
    return pedir('sku does not match the agreed format');
  }
  if (col.tipo === 'inteiro_nao_negativo') {
    const m = t.match(UNIDADE);
    const nucleo = m ? m[1].trim() : t;
    if (INT.test(nucleo) && m) return corrigir(nucleo, 'unit word removed');
    const n = lerNumeroPorExtenso(nucleo);
    if (n) return corrigir(String(n.valor), m ? `number words (${n.idioma}) and unit word` : `number words (${n.idioma})`);
    return pedir('quantity is not a whole number');
  }
  if (col.tipo === 'decimal_positivo') {
    if (DEC.test(t) && Number(t) === 0) return pedir('price zero is not allowed');
    return pedir('price is not a positive decimal with a dot');
  }
  return pedir('value does not pass the brief');
}
