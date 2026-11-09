// C3 baseline B1 (frozen before the reserved set): number words ES/PT 0..999, unit words, trim, sku case,
// approved sample value, unambiguous split-decimal rebuild only; currency always goes back to the supplier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerNumeroPorExtenso } from '../src/c3/numeros.mjs';
import { propostaB1, recombinarDecimal } from '../src/c3/b1.mjs';
import { B0 } from '../src/brief.mjs';

const b1 = (campo, original, tipo = 'rejeicao', extra = {}, chaves = []) => propostaB1({ tipo, campo, original, ...extra }, { brief: B0, chaves: new Set(chaves) });

test('number words ES and PT, 0 to 999, closed vocabulary', () => {
  const casos = { cero: 0, zero: 0, doce: 12, doze: 12, 'treinta y dos': 32, 'vinte e cinco': 25, veinticuatro: 24, cien: 100, cem: 100,
    'ciento cincuenta': 150, 'cento e dez': 110, duzentos: 200, 'novecientos noventa y nueve': 999, 'novecentos e noventa e nove': 999, Dezasseis: 16, 'TRES': 3 };
  for (const [t, v] of Object.entries(casos)) assert.equal(lerNumeroPorExtenso(t)?.valor, v, t);
  for (const t of ['trienta', 'vinte y cinco', 'una docena', 'media docena', 'ciento', 'cento', 'mil', 'treinta dos', 'cento vinte', 'dezaseis', '', 'doce doce'])
    assert.equal(lerNumeroPorExtenso(t), null, t);
});

test('B1 fixes trivial integer forms: units, number words, spaces', () => {
  assert.deepEqual([b1('stock', '15 unidades').valor, b1('stock', '7 u.').valor, b1('stock', '8 un.').valor, b1('stock', '20 uds').valor], ['15', '7', '8', '20']);
  assert.deepEqual([b1('stock', 'doce').valor, b1('stock', 'quarenta e oito unidades').valor, b1('stock', '  9 ').valor], ['12', '48', '9']);
});

test('B1 asks the supplier for anything else: approximations, notes, words outside the table, zero, empty', () => {
  for (const [campo, v] of [['stock', 'aprox 20'], ['stock', '12 (reponer el lunes)'], ['stock', 'una docena'], ['stock', 'agotado'], ['stock', 'a consultar'], ['precio', '0'], ['precio', ''], ['precio', 'dos con cincuenta']])
    assert.equal(b1(campo, v).acao, 'pedir_ao_fornecedor', v);
});

test('B1 never strips or converts a currency, in any form', () => {
  for (const v of ['USD 3.10', 'US$ 2.00', 'R$ 7.50', 'Gs 15000', '₲ 15000', '$4', '3.10 USD', 'dois reais', '5 pesos', '2 dólares'])
    assert.equal(b1('precio', v).acao, 'pedir_ao_fornecedor', v);
  assert.match(b1('precio', 'USD 3.10').motivo, /no conversion/);
  assert.equal(b1('*', 'ABC-0065,Producto 064,R$ 4,90,5').acao, 'pedir_ao_fornecedor');
});

test('split decimal is rebuilt only when the other reading (comma inside nombre) is invalid', () => {
  assert.equal(recombinarDecimal('ABC-0070,Producto 069,4,05,13', B0), 'ABC-0070,Producto 069,4.05,13', '"05" cannot be a price, so one reading');
  assert.equal(recombinarDecimal('ABC-0080,Producto 079,2,85,13', B0), null, 'nombre "Producto 079,2" with price 85 is also valid');
  assert.equal(recombinarDecimal('ABC-0071,Producto 070,5,5,13', B0), null);
  assert.equal(recombinarDecimal('ABC-0072,Producto 071,1,250.00,13', B0), null);
  assert.equal(recombinarDecimal('ABC-0073,Producto 072,3.10,13', B0), null, 'not an extra column');
  assert.equal(b1('*', 'ABC-0080,Producto 079,2,85,13').acao, 'pedir_ao_fornecedor');
});

test('sample value, sku case and keys', () => {
  assert.deepEqual(b1('precio', '2.58', 'amostra', { esperado: '2.85' }), { acao: 'corrigir', valor: '2.85', motivo: 'approved sample value' });
  assert.equal(b1('sku', 'abc-0105').valor, 'ABC-0105');
  assert.equal(b1('sku', 'abc-0001', 'rejeicao', {}, ['ABC-0001']).acao, 'pedir_ao_fornecedor', 'would collide with an existing key');
  assert.equal(b1('sku', ' ABC-0180').valor, 'ABC-0180');
  assert.equal(b1('sku', 'ABC-0042', 'duplicata').acao, 'pedir_ao_fornecedor');
  assert.equal(b1('precioo', 'sku,nombre,precioo,stock', 'cabecalho').acao, 'pedir_ao_fornecedor');
});
