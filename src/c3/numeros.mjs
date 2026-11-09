// Closed-vocabulary parser for Spanish and Portuguese number words, 0 to 999. Deterministic, no guessing:
// a text parses only if every word is in the table and the grammar is respected; otherwise null.
// If the Spanish and the Portuguese readings disagree, the result is null (ambiguous).

const sem = (t) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

const ES = {
  zero: ['cero'],
  unidades: { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9 },
  especiais: {
    diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
    veinte: 20, veintiun: 21, veintiuno: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25,
    veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
  },
  dezenas: { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 },
  cem: 'cien',
  centenas: { ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900 },
  e_dezena: 'y', // treinta y dos
  e_centena: null, // ciento veinte
};
const PT = {
  zero: ['zero'],
  unidades: { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9 },
  especiais: { dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14, quinze: 15, dezesseis: 16, dezasseis: 16, dezessete: 17, dezassete: 17, dezoito: 18, dezenove: 19, dezanove: 19 },
  dezenas: { vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90 },
  cem: 'cem',
  centenas: { cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, trezentas: 300, quatrocentos: 400, quatrocentas: 400, quinhentos: 500, quinhentas: 500, seiscentos: 600, seiscentas: 600, setecentos: 700, setecentas: 700, oitocentos: 800, oitocentas: 800, novecentos: 900, novecentas: 900 },
  e_dezena: 'e', // vinte e cinco
  e_centena: 'e', // cento e vinte
};

/** Value 1..99 from the whole token list, or null. */
function menorQueCem(L, t) {
  if (t.length === 1) return L.unidades[t[0]] ?? L.especiais[t[0]] ?? L.dezenas[t[0]] ?? null;
  if (t.length === 3 && L.dezenas[t[0]] !== undefined && t[1] === L.e_dezena && L.unidades[t[2]] !== undefined) return L.dezenas[t[0]] + L.unidades[t[2]];
  return null;
}

function lerIdioma(L, texto) {
  const t = sem(texto).split(' ').filter(Boolean);
  if (!t.length) return null;
  if (t.length === 1 && L.zero.includes(t[0])) return 0;
  if (t.length === 1 && t[0] === L.cem) return 100;
  if (L.centenas[t[0]] !== undefined) {
    const c = L.centenas[t[0]];
    let resto = t.slice(1);
    if (!resto.length) return t[0] === 'ciento' || t[0] === 'cento' ? null : c; // "ciento"/"cento" alone is not a number
    if (L.e_centena) { if (resto[0] !== L.e_centena) return null; resto = resto.slice(1); }
    const r = menorQueCem(L, resto);
    return r === null ? null : c + r;
  }
  return menorQueCem(L, t);
}

/** { valor, idioma } for an unambiguous reading, or null. */
export function lerNumeroPorExtenso(texto) {
  if (typeof texto !== 'string' || texto.length > 60) return null;
  const es = lerIdioma(ES, texto), pt = lerIdioma(PT, texto);
  if (es !== null && pt !== null) return es === pt ? { valor: es, idioma: 'es/pt' } : null;
  if (es !== null) return { valor: es, idioma: 'es' };
  if (pt !== null) return { valor: pt, idioma: 'pt' };
  return null;
}
