// The C3 evaluation lots and labels are frozen: regenerating them gives the same bytes, the manifest hashes match,
// and every finding of the deterministic report has exactly one label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lotesC3 } from '../src/c3/gerar_c3.mjs';
import { validar } from '../src/validar.mjs';
import { extrairAchados } from '../src/c3/achados.mjs';
import { B0 } from '../src/brief.mjs';

const dir = new URL('../fixtures/C3/', import.meta.url);
const ler = (n) => readFileSync(new URL(n, dir), 'utf8');
const AMOSTRA = readFileSync(new URL('../fixtures/L0/AMOSTRA-L0-linhas-2-11.csv', import.meta.url), 'utf8');
const MANIFEST = JSON.parse(ler('MANIFEST.json'));

test('manifest hashes match the committed files and the generator output', () => {
  const gerado = lotesC3();
  for (const [n, { sha256, bytes }] of Object.entries(MANIFEST.arquivos)) {
    const t = ler(n);
    assert.equal(createHash('sha256').update(t).digest('hex'), sha256, n);
    assert.equal(Buffer.byteLength(t), bytes, n);
    assert.equal(gerado[n], t, `generator reproduces ${n}`);
  }
  assert.equal(Object.keys(MANIFEST.arquivos).length, 8);
});

test('every finding has exactly one label, with the literal original cell', () => {
  for (const nome of [...MANIFEST.conjuntos.desenvolvimento, ...MANIFEST.conjuntos.reservado]) {
    const lote = ler(`${nome}.csv`); const g = JSON.parse(ler(`${nome}.gabarito.json`));
    assert.equal(g.lote_sha256, createHash('sha256').update(lote).digest('hex'));
    const achados = extrairAchados(validar(B0, lote, AMOSTRA), lote, B0);
    assert.deepEqual(achados.map((a) => a.id).sort(), g.itens.map((i) => i.id).sort(), nome);
    for (const it of g.itens) assert.equal(achados.find((a) => a.id === it.id).original, it.original, it.id);
    for (const it of g.itens) if (it.esperado.acao === 'corrigir') assert.equal(typeof it.esperado.valor, 'string');
  }
});
