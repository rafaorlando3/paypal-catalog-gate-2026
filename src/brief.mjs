// Brief B0 of the R1 specification: the acceptance rules agreed before delivery.
export const B0 = {
  idioma: 'es',
  colunas: [
    { nome: 'sku', tipo: 'texto', obrigatorio: true, regex: '^[A-Z]{3}-[0-9]{4}$' },
    { nome: 'nombre', tipo: 'texto', obrigatorio: true },
    { nome: 'precio', tipo: 'decimal_positivo', obrigatorio: true },
    { nome: 'stock', tipo: 'inteiro_nao_negativo', obrigatorio: true },
  ],
  chave: 'sku',
  linhas_esperadas: 200,
  tolerancia_rejeicao: 0.02,
};
