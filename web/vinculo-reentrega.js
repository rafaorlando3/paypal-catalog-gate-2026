// C3a: a built redelivery request is valid only for the exact order, delivered lot, delivery revision,
// suggestion/decision revision and language it was built from. Any change makes it obsolete.
// Classic script (CSP script-src 'self'); exposes globalThis.VinculoReentrega. Pure functions, no DOM.
(function (g) {
  function chave(v) {
    if (!v || !v.pedido || !v.lote_sha256 || v.revisao_entrega == null || v.revisao_sugestoes == null || !v.idioma) return null;
    return [v.pedido, v.lote_sha256, v.revisao_entrega, v.revisao_sugestoes, v.idioma].join('|');
  }
  /** Dependencies of the request as shown now: from the current order view and the selected language. */
  function chaveAtual(pedido, idioma) {
    const sg = pedido && pedido.sugestoes;
    if (!sg || sg.lote_sha256 !== pedido.lote_sha256 || sg.revisao_entrega !== pedido.revisao_entrega) return null;
    return chave({ pedido: pedido.id, lote_sha256: sg.lote_sha256, revisao_entrega: sg.revisao_entrega, revisao_sugestoes: sg.revisao, idioma: idioma });
  }
  /** From the server answer of pedido_reentrega: the text and the exact dependencies it was built from. */
  function gerado(resp) {
    const r = resp && resp.reentrega;
    const k = chave(r);
    return k && typeof r.texto === 'string' ? { chave: k, texto: r.texto } : null;
  }
  /** Text to display: the built request only while every dependency is unchanged; otherwise nothing. */
  function textoVisivel(geradoAtual, pedido, idioma) {
    const k = chaveAtual(pedido, idioma);
    return geradoAtual && k && geradoAtual.chave === k ? geradoAtual.texto : '';
  }
  g.VinculoReentrega = { chave: chave, chaveAtual: chaveAtual, gerado: gerado, textoVisivel: textoVisivel };
})(typeof globalThis !== 'undefined' ? globalThis : this);
