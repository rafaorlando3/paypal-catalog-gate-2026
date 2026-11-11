// Advisory explanation of report C. It cites lines; a checker rejects citations that do not exist.
// The advisory never enables or blocks capture.

const CITA = /\b(?:linha|línea|linea|line|row)s?\s+(\d+(?:\s*(?:,|e|y|and)\s*\d+)*)/gi;

export function linhasCitadas(texto) {
  const out = [];
  for (const m of texto.matchAll(CITA)) for (const n of m[1].split(/\s*(?:,|e|y|and)\s*/)) out.push(Number(n));
  return out;
}

export function checarParecer(texto, rel) {
  if (typeof texto !== 'string' || !texto.trim()) return { ok: false, motivo: 'empty advisory' };
  const max = rel.lidas + 1; // header is line 1
  const citadas = linhasCitadas(texto);
  const fora = citadas.filter((n) => n < 1 || n > max);
  if (fora.length) return { ok: false, motivo: `cites a line that does not exist: ${fora.join(', ')} (valid 1..${max})` };
  const relevantes = new Set([...rel.rejeicoes.map((r) => r.linha), ...rel.duplicatas.flatMap((d) => d.linhas), ...rel.amostra.filter((a) => !a.confere).map((a) => a.linha)]);
  const semBase = citadas.filter((n) => !relevantes.has(n));
  if (semBase.length) return { ok: false, motivo: `cites a line with no finding in the report: ${semBase.join(', ')}` };
  if (relevantes.size && !citadas.length) return { ok: false, motivo: 'there are findings and the advisory cites no line' };
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
export function geradorGemini({ chave = process.env.GEMINI_API_KEY, modelo = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite', timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) {
  // Only this verified model is qualified; an environment value cannot alter the URL path.
  if (modelo !== 'gemini-3.5-flash-lite') throw new Error('Unsupported advisory model');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid advisory timeout');
  if (typeof fetchImpl !== 'function') throw new Error('Invalid advisory transport');
  const erro = (codigo) => {
    const mensagens = {
      advisory_timeout: 'AI advisory timeout',
      advisory_http: 'AI advisory HTTP error',
      advisory_too_large: 'AI advisory response too large',
      advisory_invalid: 'AI advisory invalid response',
      advisory_unavailable: 'AI advisory unavailable',
      advisory_input: 'AI advisory input too large',
    };
    const e = new Error(mensagens[codigo]); e.codigo = codigo; return e;
  };
  return async (rel, brief) => {
    if (!chave) throw erro('advisory_unavailable');
    if (!rel.rejeicoes.length && !rel.duplicatas.length && rel.amostra.every((a) => a.confere)) return `All ${rel.validas} rows passed the agreed rules and the approved sample matches.`;
    const textoPrompt = prompt(rel, brief);
    if (Buffer.byteLength(textoPrompt, 'utf8') > 16384) throw erro('advisory_input');
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
        method: 'POST', signal: ctrl.signal, redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': chave },
        body: JSON.stringify({ contents: [{ parts: [{ text: textoPrompt }] }], generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'MINIMAL' } } }),
      });
      if (!r.ok) {
        await r.body?.cancel().catch(() => {});
        const e = erro('advisory_http');
        if (Number.isInteger(r.status)) e.status = r.status;
        throw e;
      }
      if (!r.body || typeof r.body.getReader !== 'function') throw erro('advisory_invalid');
      const reader = r.body.getReader(); const partes = []; let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 65536) { await reader.cancel().catch(() => {}); throw erro('advisory_too_large'); }
          partes.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      let j;
      try { j = JSON.parse(Buffer.concat(partes, bytes).toString('utf8')); }
      catch { throw erro('advisory_invalid'); }
      const candidato = j?.candidates?.[0];
      if (candidato?.finishReason !== 'STOP') throw erro('advisory_invalid');
      const partesRecebidas = candidato?.content?.parts;
      if (!Array.isArray(partesRecebidas)) throw erro('advisory_invalid');
      const partesTexto = partesRecebidas.filter((x) => x?.thought !== true && !(x && typeof x === 'object' && !Object.hasOwn(x, 'text') && typeof x.thoughtSignature === 'string' && Object.keys(x).every((k) => k === 'thoughtSignature')));
      if (!Array.isArray(partesTexto) || partesTexto.some((x) => typeof x?.text !== 'string')) throw erro('advisory_invalid');
      const texto = partesTexto.map((x) => x.text).join('');
      if (Buffer.byteLength(texto, 'utf8') > 8192) throw erro('advisory_too_large');
      return texto;
    } catch (e) {
      if (ctrl.signal.aborted) throw erro('advisory_timeout');
      if (e && ['advisory_http', 'advisory_too_large', 'advisory_invalid'].includes(e.codigo)) {
        const publico = erro(e.codigo);
        if (e.codigo === 'advisory_http' && Number.isInteger(e.status)) publico.status = e.status;
        throw publico;
      }
      throw erro('advisory_unavailable');
    } finally { clearTimeout(t); }
  };
}

/**
 * Fixed (template) explanation built only from report C. It is the baseline the model's explanation is compared with:
 * same facts, no model. Deterministic, so the demo can show what the model adds and what the checker catches.
 */
export function explicacaoFixa(rel) {
  const VEREDITO = { verde: 'PASS', amarelo: 'PASS WITH REJECTIONS', vermelho: 'FAIL' };
  const partes = [`Verdict ${VEREDITO[rel.veredito]}${rel.motivos.length ? ` (${rel.motivos.join('; ')})` : ''}: ${rel.validas} of ${rel.lidas} rows pass the row rules.`];
  for (const r of rel.rejeicoes) partes.push(r.motivo === 'header' ? `Line ${r.linha}: header column "${r.campo}" differs from the brief.` : `Line ${r.linha}: ${r.campo} ${r.motivo}.`);
  for (const d of rel.duplicatas) partes.push(`Lines ${d.linhas.join(' and ')}: duplicate key ${d.chave}.`);
  for (const a of rel.amostra.filter((x) => !x.confere)) partes.push(`Line ${a.linha}: ${a.campo} is ${a.recebido}, the approved sample says ${a.esperado}.`);
  return partes.join(' ');
}
