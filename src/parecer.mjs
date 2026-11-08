// Advisory explanation of report C. It cites lines; a checker rejects citations that do not exist.
// The advisory never enables or blocks capture.

const CITA = /\b(?:linha|línea|linea|line|row)s?\s+(\d+(?:\s*(?:,|e|y|and)\s*\d+)*)/gi;

export function linhasCitadas(texto) {
  const out = [];
  for (const m of texto.matchAll(CITA)) for (const n of m[1].split(/\s*(?:,|e|y|and)\s*/)) out.push(Number(n));
  return out;
}

export function checarParecer(texto, rel) {
  if (typeof texto !== 'string' || !texto.trim()) return { ok: false, motivo: 'parecer vazio' };
  const max = rel.lidas + 1; // header is line 1
  const citadas = linhasCitadas(texto);
  const fora = citadas.filter((n) => n < 1 || n > max);
  if (fora.length) return { ok: false, motivo: `cita linha inexistente: ${fora.join(', ')} (válidas 1..${max})` };
  const relevantes = new Set([...rel.rejeicoes.map((r) => r.linha), ...rel.duplicatas.flatMap((d) => d.linhas), ...rel.amostra.filter((a) => !a.confere).map((a) => a.linha)]);
  const semBase = citadas.filter((n) => !relevantes.has(n));
  if (semBase.length) return { ok: false, motivo: `cita linha sem achado no relatório: ${semBase.join(', ')}` };
  if (relevantes.size && !citadas.length) return { ok: false, motivo: 'há achados e o parecer não cita linha' };
  return { ok: true };
}

/** Builds the prompt from report C only (never the raw file), so the model cannot invent rows. */
export function prompt(rel, brief) {
  return [
    'You explain a deterministic catalog import check to a small business buyer. You do NOT decide payment.',
    `Expected columns: ${brief.colunas.map((c) => c.nome).join(', ')}. Expected rows: ${brief.linhas_esperadas}. Tolerance: ${brief.tolerancia_rejeicao * 100}%.`,
    `Verdict (already decided by rules): ${rel.veredito}. Reasons: ${rel.motivos.join('; ') || 'none'}.`,
    `Rejections: ${JSON.stringify(rel.rejeicoes)}. Duplicates: ${JSON.stringify(rel.duplicatas)}. Sample mismatches: ${JSON.stringify(rel.amostra.filter((a) => !a.confere))}.`,
    'Write at most 4 short sentences in English. Cite each finding as "line N" using only the line numbers above. Do not mention any other line. Do not recommend paying or not paying.',
  ].join('\n');
}

/** Optional live advisor (Gemini REST). Without a key it throws, and the UI shows "advisory unavailable". */
export function geradorGemini({ chave = process.env.GEMINI_API_KEY, modelo = process.env.GEMINI_MODEL || 'gemini-2.5-flash', timeoutMs = 15000 } = {}) {
  return async (rel, brief) => {
    if (!chave) throw new Error('GEMINI_API_KEY ausente');
    if (!rel.rejeicoes.length && !rel.duplicatas.length && rel.amostra.every((a) => a.confere)) return `All ${rel.validas} rows passed the agreed rules and the approved sample matches.`;
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': chave },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt(rel, brief) }] }], generationConfig: { temperature: 0, maxOutputTokens: 300 } }),
      });
      if (!r.ok) throw new Error(`modelo respondeu ${r.status}`);
      const j = await r.json();
      return j.candidates?.[0]?.content?.parts?.map((x) => x.text).join('') || '';
    } finally { clearTimeout(t); }
  };
}
