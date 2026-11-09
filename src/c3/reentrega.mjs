// Fixed-template supplier redelivery request in Spanish or Portuguese, built only from the suggestion items and the
// person's decisions. Model text never enters this message. The agreed rules do not change.

const limpo = (t) => String(t).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/"/g, "'").slice(0, 60);

const FRASES = {
  es: {
    titulo: (sha) => `Pedido de nueva entrega del catálogo (archivo recibido sha256 ${sha.slice(0, 12)}). Las reglas acordadas no cambian; la nueva entrega se verifica completa otra vez.`,
    cambiar: (it, v) => it.campo === '*' ? `Línea ${it.linha}: la línea tiene una columna de más; enviarla como "${limpo(v)}".` : `Línea ${it.linha}, ${it.campo}: cambiar "${limpo(it.original)}" por "${limpo(v)}".`,
    cabecalho: (it, b) => `Línea 1: el encabezado debe ser exactamente ${b.colunas.map((c) => c.nome).join(',')}.`,
    duplicata: (it) => `Líneas ${it.linhas.join(' y ')}: la clave ${limpo(it.original)} se repite; dejar una sola fila correcta.`,
    amostra: (it) => `Línea ${it.linha}, ${it.campo}: el valor debe coincidir con la muestra aprobada (recibido "${limpo(it.original)}").`,
    '*': (it) => `Línea ${it.linha}: la línea tiene una columna de más; usar punto decimal, sin comas extra (recibido "${limpo(it.original)}").`,
    precio: (it) => `Línea ${it.linha}, precio: indicar un número mayor que cero con punto decimal, sin moneda (recibido "${limpo(it.original)}").`,
    stock: (it) => `Línea ${it.linha}, stock: indicar un número entero, sin texto (recibido "${limpo(it.original)}").`,
    sku: (it) => `Línea ${it.linha}, sku: usar el formato acordado AAA-0000 (recibido "${limpo(it.original)}").`,
    otro: (it) => `Línea ${it.linha}, ${it.campo}: corregir el valor (recibido "${limpo(it.original)}").`,
    fim: 'Gracias.',
  },
  pt: {
    titulo: (sha) => `Pedido de nova entrega do catálogo (arquivo recebido sha256 ${sha.slice(0, 12)}). As regras combinadas não mudam; a nova entrega é verificada inteira outra vez.`,
    cambiar: (it, v) => it.campo === '*' ? `Linha ${it.linha}: a linha tem uma coluna a mais; enviá-la como "${limpo(v)}".` : `Linha ${it.linha}, ${it.campo}: trocar "${limpo(it.original)}" por "${limpo(v)}".`,
    cabecalho: (it, b) => `Linha 1: o cabeçalho deve ser exatamente ${b.colunas.map((c) => c.nome).join(',')}.`,
    duplicata: (it) => `Linhas ${it.linhas.join(' e ')}: a chave ${limpo(it.original)} se repete; deixar uma única linha correta.`,
    amostra: (it) => `Linha ${it.linha}, ${it.campo}: o valor deve ser igual ao da amostra aprovada (recebido "${limpo(it.original)}").`,
    '*': (it) => `Linha ${it.linha}: a linha tem uma coluna a mais; usar ponto decimal, sem vírgulas extras (recebido "${limpo(it.original)}").`,
    precio: (it) => `Linha ${it.linha}, precio: informar um número maior que zero com ponto decimal, sem moeda (recebido "${limpo(it.original)}").`,
    stock: (it) => `Linha ${it.linha}, stock: informar um número inteiro, sem texto (recebido "${limpo(it.original)}").`,
    sku: (it) => `Linha ${it.linha}, sku: usar o formato combinado AAA-0000 (recebido "${limpo(it.original)}").`,
    otro: (it) => `Linha ${it.linha}, ${it.campo}: corrigir o valor (recebido "${limpo(it.original)}").`,
    fim: 'Obrigado.',
  },
};

export function textoReentrega(sugestoes, idioma, brief) {
  const F = FRASES[idioma];
  if (!F) throw new Error('language must be es or pt');
  const linhas = [F.titulo(sugestoes.lote_sha256)];
  for (const it of [...sugestoes.itens].sort((a, b) => a.linha - b.linha || a.sid.localeCompare(b.sid))) {
    if (it.decisao?.aceitar === true) { linhas.push(`- ${F.cambiar(it, it.decisao.valor)}`); continue; }
    const f = it.tipo === 'cabecalho' ? F.cabecalho : it.tipo === 'duplicata' ? F.duplicata : it.tipo === 'amostra' ? F.amostra : F[it.campo] || F.otro;
    linhas.push(`- ${f(it, brief)}`);
  }
  linhas.push(F.fim);
  return linhas.join('\n');
}
