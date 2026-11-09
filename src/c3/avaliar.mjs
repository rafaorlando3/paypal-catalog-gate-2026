// C3 offline evaluation against the frozen labels. B1 always. The AI arm only scores answers that were already
// recorded (--respostas DIR, files <lote>.run<k>.txt); this script never calls a provider and C3 ships none.
// Usage: node src/c3/avaliar.mjs [--conjunto desenvolvimento|reservado|todos] [--respostas DIR] [--saida FILE]
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validar } from '../validar.mjs';
import { B0 } from '../brief.mjs';
import { extrairAchados, linhasDe } from './achados.mjs';
import { propostaB1 } from './b1.mjs';
import { validarResposta, checarProposta } from './sugestoes.mjs';

const RAIZ = new URL('../../', import.meta.url);
const ler = (rel) => readFileSync(new URL(rel, RAIZ), 'utf8');
const sha = (t) => createHash('sha256').update(t).digest('hex');

/** Compares one proposal with its label: correta | errada | inventada | abstencao | sem_proposta. */
export function classificar(prop, esperado) {
  if (!prop) return 'sem_proposta';
  if (esperado.acao === 'pedir_ao_fornecedor') return prop.acao === 'pedir_ao_fornecedor' ? 'correta' : 'inventada';
  if (prop.acao === 'pedir_ao_fornecedor') return 'abstencao';
  return prop.valor === esperado.valor ? 'correta' : 'errada';
}
const vazio = () => ({ correta: 0, errada: 0, inventada: 0, abstencao: 0, sem_proposta: 0 });

export function avaliar({ conjunto = 'todos', respostas = null } = {}) {
  const manifest = JSON.parse(ler('fixtures/C3/MANIFEST.json'));
  for (const [n, { sha256 }] of Object.entries(manifest.arquivos)) if (sha(ler(`fixtures/C3/${n}`)) !== sha256) throw new Error(`frozen file changed: ${n}`);
  const amostra = ler('fixtures/L0/AMOSTRA-L0-linhas-2-11.csv');
  const nomes = conjunto === 'todos' ? [...manifest.conjuntos.desenvolvimento, ...manifest.conjuntos.reservado] : manifest.conjuntos[conjunto];
  if (!nomes) throw new Error('conjunto must be desenvolvimento, reservado or todos');
  const out = { manifest_sha256: sha(ler('fixtures/C3/MANIFEST.json')), braco_ia: respostas ? 'recorded answers scored' : 'not run: no provider in C3 and no recorded answers', lotes: {} };
  for (const nome of nomes) {
    const lote = ler(`fixtures/C3/${nome}.csv`);
    const g = JSON.parse(ler(`fixtures/C3/${nome}.gabarito.json`));
    const achados = extrairAchados(validar(B0, lote, amostra), lote, B0);
    const j = B0.colunas.findIndex((c) => c.nome === B0.chave);
    const chaves = new Set(linhasDe(lote).slice(1).map((l) => l.split(',')[j]).filter(Boolean));
    const r = { conjunto: g.conjunto, achados: achados.length, B1: { total: vazio(), por_categoria: {} }, ia: [] };
    for (const it of g.itens) {
      const a = achados.find((x) => x.id === it.id);
      const c = classificar(propostaB1(a, { brief: B0, chaves }), it.esperado);
      r.B1.total[c]++; (r.B1.por_categoria[it.categoria] ??= vazio())[c]++;
    }
    for (let k = 1; respostas && existsSync(`${respostas}/${nome}.run${k}.txt`); k++) {
      const bruto = readFileSync(`${respostas}/${nome}.run${k}.txt`, 'utf8');
      const v = validarResposta(bruto, achados);
      const run = { run: k, resposta_sha256: sha(bruto), valida: v.ok, ...(v.ok ? {} : { motivo: v.motivo }), A: vazio(), A_mais_checador: vazio() };
      for (const it of g.itens) {
        const a = achados.find((x) => x.id === it.id);
        const prop = v.ok ? v.itens.get(it.id) : null;
        run.A[classificar(prop, it.esperado)]++;
        const ok = prop && checarProposta(a, prop, { brief: B0, chaves }).aceita;
        run.A_mais_checador[classificar(prop ? (ok ? prop : { acao: 'pedir_ao_fornecedor', valor: null }) : null, it.esperado)]++;
      }
      r.ia.push(run);
    }
    out.lotes[nome] = r;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const res = avaliar({ conjunto: arg('--conjunto') || 'todos', respostas: arg('--respostas') || null });
  const txt = JSON.stringify(res, null, 2) + '\n';
  if (arg('--saida')) writeFileSync(arg('--saida'), txt); else process.stdout.write(txt);
}
