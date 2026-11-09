// Findings of the deterministic report, joined with the literal delivered cells they refer to.
// Read-only: it never changes the lot, the report or the verdict.

const linhasDe = (lote) => { const c = lote.endsWith('\n') ? lote.slice(0, -1) : lote; return c.split('\n').map((l) => l.replace(/\r$/, '')); };

/**
 * @returns {Array<{id, tipo, linha, campo, motivo, original, linha_texto, esperado?, linhas?}>}
 * tipo: 'cabecalho' | 'rejeicao' | 'amostra' | 'duplicata'. ids are stable: `${tipo}:${linha}:${campo}` (duplicata: `duplicata:${chave}`).
 */
export function extrairAchados(relatorio, lote, brief) {
  const L = linhasDe(lote);
  const nomes = brief.colunas.map((c) => c.nome);
  const out = [];
  for (const r of relatorio.rejeicoes) {
    const texto = L[r.linha - 1] ?? '';
    if (r.motivo === 'header') { out.push({ id: `cabecalho:1:${r.campo}`, tipo: 'cabecalho', linha: 1, campo: r.campo, motivo: 'header', original: texto, linha_texto: texto }); continue; }
    const j = nomes.indexOf(r.campo);
    const original = r.campo === '*' ? texto : (texto.split(',')[j] ?? '');
    out.push({ id: `rejeicao:${r.linha}:${r.campo}`, tipo: 'rejeicao', linha: r.linha, campo: r.campo, motivo: r.motivo, original, linha_texto: texto });
  }
  for (const a of relatorio.amostra.filter((x) => !x.confere)) {
    out.push({ id: `amostra:${a.linha}:${a.campo}`, tipo: 'amostra', linha: a.linha, campo: a.campo, motivo: 'approved sample differs', original: a.recebido ?? '', esperado: a.esperado, linha_texto: L[a.linha - 1] ?? '' });
  }
  for (const d of relatorio.duplicatas) {
    out.push({ id: `duplicata:${d.chave}`, tipo: 'duplicata', linha: d.linhas[0], linhas: d.linhas, campo: brief.chave, motivo: 'duplicate key', original: d.chave, linha_texto: d.linhas.map((n) => L[n - 1] ?? '').join('\n') });
  }
  return out;
}

export { linhasDe };
