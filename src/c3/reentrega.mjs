// Fixed-template supplier redelivery request in Spanish or Portuguese, built only from the suggestion items and the
// person's decisions. Model text never enters this message. The agreed rules do not change.
//
// C3a: an accepted value is written COMPLETE and VERBATIM on its own indented line, never truncated, so a long field
// or a whole rebuilt CSV line keeps every column. Received values are quoted only as previews; a preview that was
// shortened says so explicitly and is never presented as the replacement.

const MAX_PREVIA = 60;
const CONTROLE = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]');
const previa = (t) => {
  const s = String(t).replace(new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]', 'g'), ' ').replace(/"/g, "'");
  return s.length > MAX_PREVIA ? { texto: s.slice(0, MAX_PREVIA), cortado: true } : { texto: s, cortado: false };
};

const FRASES = {
  es: {
    titulo: (sha) => `Pedido de nueva entrega del catálogo (archivo recibido sha256 ${sha.slice(0, 12)}). Las reglas acordadas no cambian; la nueva entrega se verifica completa otra vez.`,
    recebido: (it) => { const p = previa(it.original); return p.cortado || it.original_truncado ? `recibido, vista previa recortada: "${p.texto}…"` : `recibido: "${p.texto}"`; },
    linhaExata: (it) => `Línea ${it.linha}: la línea tiene una columna de más (${FRASES.es.recebido(it)}). Reemplazarla completa por esta línea exacta:`,
    campoExato: (it) => `Línea ${it.linha}, ${it.campo} (${FRASES.es.recebido(it)}): usar exactamente este valor:`,
    cabecalho: (it, b) => `Línea 1: el encabezado debe ser exactamente ${b.colunas.map((c) => c.nome).join(',')}.`,
    duplicata: (it) => `Líneas ${it.linhas.join(' y ')}: la clave ${previa(it.original).texto} se repite; dejar una sola fila correcta.`,
    amostra: (it) => `Línea ${it.linha}, ${it.campo}: el valor debe coincidir con la muestra aprobada (${FRASES.es.recebido(it)}).`,
    '*': (it) => `Línea ${it.linha}: la línea tiene una columna de más; usar punto decimal, sin comas extra (${FRASES.es.recebido(it)}).`,
    precio: (it) => `Línea ${it.linha}, precio: indicar un número mayor que cero con punto decimal, sin moneda (${FRASES.es.recebido(it)}).`,
    stock: (it) => `Línea ${it.linha}, stock: indicar un número entero, sin texto (${FRASES.es.recebido(it)}).`,
    sku: (it) => `Línea ${it.linha}, sku: usar el formato acordado AAA-0000 (${FRASES.es.recebido(it)}).`,
    otro: (it) => `Línea ${it.linha}, ${it.campo}: corregir el valor (${FRASES.es.recebido(it)}).`,
    fim: 'Gracias.',
  },
  pt: {
    titulo: (sha) => `Pedido de nova entrega do catálogo (arquivo recebido sha256 ${sha.slice(0, 12)}). As regras combinadas não mudam; a nova entrega é verificada inteira outra vez.`,
    recebido: (it) => { const p = previa(it.original); return p.cortado || it.original_truncado ? `recebido, prévia cortada: "${p.texto}…"` : `recebido: "${p.texto}"`; },
    linhaExata: (it) => `Linha ${it.linha}: a linha tem uma coluna a mais (${FRASES.pt.recebido(it)}). Substituí-la inteira por esta linha exata:`,
    campoExato: (it) => `Linha ${it.linha}, ${it.campo} (${FRASES.pt.recebido(it)}): usar exatamente este valor:`,
    cabecalho: (it, b) => `Linha 1: o cabeçalho deve ser exatamente ${b.colunas.map((c) => c.nome).join(',')}.`,
    duplicata: (it) => `Linhas ${it.linhas.join(' e ')}: a chave ${previa(it.original).texto} se repete; deixar uma única linha correta.`,
    amostra: (it) => `Linha ${it.linha}, ${it.campo}: o valor deve ser igual ao da amostra aprovada (${FRASES.pt.recebido(it)}).`,
    '*': (it) => `Linha ${it.linha}: a linha tem uma coluna a mais; usar ponto decimal, sem vírgulas extras (${FRASES.pt.recebido(it)}).`,
    precio: (it) => `Linha ${it.linha}, precio: informar um número maior que zero com ponto decimal, sem moeda (${FRASES.pt.recebido(it)}).`,
    stock: (it) => `Linha ${it.linha}, stock: informar um número inteiro, sem texto (${FRASES.pt.recebido(it)}).`,
    sku: (it) => `Linha ${it.linha}, sku: usar o formato combinado AAA-0000 (${FRASES.pt.recebido(it)}).`,
    otro: (it) => `Linha ${it.linha}, ${it.campo}: corrigir o valor (${FRASES.pt.recebido(it)}).`,
    fim: 'Obrigado.',
  },
};

/** The exact value goes alone on an indented line, byte for byte. A value that cannot be written verbatim is not used. */
export const valorExatoSeguro = (v) => typeof v === 'string' && v.length > 0 && !CONTROLE.test(v);

export function textoReentrega(sugestoes, idioma, brief) {
  const F = FRASES[idioma];
  if (!F) throw new Error('language must be es or pt');
  const linhas = [F.titulo(sugestoes.lote_sha256)];
  for (const it of [...sugestoes.itens].sort((a, b) => a.linha - b.linha || a.sid.localeCompare(b.sid))) {
    if (it.decisao?.aceitar === true && valorExatoSeguro(it.decisao.valor)) {
      linhas.push(`- ${it.campo === '*' ? F.linhaExata(it) : F.campoExato(it)}`);
      linhas.push(`    ${it.decisao.valor}`);
      continue;
    }
    const f = it.tipo === 'cabecalho' ? F.cabecalho : it.tipo === 'duplicata' ? F.duplicata : it.tipo === 'amostra' ? F.amostra : F[it.campo] || F.otro;
    linhas.push(`- ${f(it, brief)}`);
  }
  linhas.push(F.fim);
  return linhas.join('\n');
}
