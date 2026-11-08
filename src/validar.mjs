// Deterministic acceptance check (report C). The model never takes part in this verdict.
import { createHash } from 'node:crypto';

const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const DEC = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/;
const INT = /^(?:0|[1-9][0-9]*)$/;

function parse(texto) {
  const corpo = texto.endsWith('\n') ? texto.slice(0, -1) : texto;
  return corpo.split('\n').map((l) => l.replace(/\r$/, ''));
}

function checarCampo(col, valor) {
  if (valor === undefined || valor === '') return col.obrigatorio ? 'required' : null;
  if (col.regex && !new RegExp(col.regex).test(valor)) return 'format';
  if (col.tipo === 'decimal_positivo' && (!DEC.test(valor) || Number(valor) <= 0)) return 'decimal > 0';
  if (col.tipo === 'inteiro_nao_negativo' && !INT.test(valor)) return 'integer >= 0';
  return null;
}

/**
 * @param {object} brief  B0-like brief
 * @param {string} lote   CSV text delivered by the supplier
 * @param {string} amostra approved sample: literal data lines 2..11 of the agreed lot (no header)
 */
export function validar(brief, lote, amostra) {
  const lote_sha256 = sha256(lote);
  const linhas = parse(lote);
  const esperado = brief.colunas.map((c) => c.nome).join(',');
  const minimo = Math.ceil(brief.linhas_esperadas * (1 - brief.tolerancia_rejeicao));
  const base = { lote_sha256, lidas: 0, validas: 0, minimo_validas: minimo, rejeicoes: [], duplicatas: [], amostra: [] };
  if (linhas[0] !== esperado) {
    const recebidos = (linhas[0] || '').split(',');
    const errados = recebidos.filter((c, i) => c !== brief.colunas[i]?.nome);
    return { ...base, rejeicoes: [{ linha: 1, campo: errados.join('|') || '(vazio)', motivo: 'header' }], veredito: 'vermelho', motivos: ['header differs from the brief'] };
  }
  const dados = linhas.slice(1);
  const vistos = new Map();
  const rejeicoes = [];
  let validas = 0;
  dados.forEach((l, i) => {
    const linha = i + 2;
    const cel = l.split(',');
    let erro = null;
    if (cel.length !== brief.colunas.length) erro = { linha, campo: '*', motivo: 'column count' };
    else for (let j = 0; j < brief.colunas.length && !erro; j++) {
      const m = checarCampo(brief.colunas[j], cel[j]);
      if (m) erro = { linha, campo: brief.colunas[j].nome, motivo: m };
    }
    if (erro) rejeicoes.push(erro); else validas++;
    const k = cel[brief.colunas.findIndex((c) => c.nome === brief.chave)];
    if (k) vistos.set(k, [...(vistos.get(k) || []), linha]);
  });
  const duplicatas = [...vistos].filter(([, ls]) => ls.length > 1).map(([chave, ls]) => ({ chave, linhas: ls }));
  const am = parse(amostra);
  const amostraRes = am.map((esperadoLinha, i) => {
    const linha = i + 2;
    const recebido = linhas[linha - 1];
    const r = { linha, confere: recebido === esperadoLinha };
    if (!r.confere) {
      const e = esperadoLinha.split(','), g = (recebido || '').split(',');
      const j = e.findIndex((v, x) => v !== g[x]);
      Object.assign(r, { campo: brief.colunas[j]?.nome, esperado: e[j], recebido: g[j] });
    }
    return r;
  });
  const motivos = [];
  if (duplicatas.length) motivos.push('duplicate key');
  if (amostraRes.some((a) => !a.confere)) motivos.push('approved sample differs');
  if (validas < minimo) motivos.push(`valid rows ${validas} below the minimum ${minimo}`);
  const veredito = motivos.length ? 'vermelho' : rejeicoes.length ? 'amarelo' : 'verde';
  return { ...base, lidas: dados.length, validas, rejeicoes, duplicatas, amostra: amostraRes, veredito, motivos };
}
