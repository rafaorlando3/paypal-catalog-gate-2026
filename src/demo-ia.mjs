// AI demo on defective lots: deterministic report -> fixed template explanation -> (optional) model explanation -> checker.
// Without GEMINI_API_KEY it prints only the fixed explanation and the checker on a canned bad text (labeled as canned).
// The checker verifies citations only (lines exist and carry a finding); it does not prove the explanation is right.
import { readFileSync } from 'node:fs';
import { validar } from './validar.mjs';
import { B0 } from './brief.mjs';
import { checarParecer, explicacaoFixa, linhasCitadas, geradorGemini } from './parecer.mjs';

const ler = (n) => readFileSync(new URL(`../fixtures/L0/${n}`, import.meta.url), 'utf8');
const AMOSTRA = ler('AMOSTRA-L0-linhas-2-11.csv');
const gerar = process.env.GEMINI_API_KEY ? geradorGemini() : null;

for (const lote of (process.argv.slice(2).length ? process.argv.slice(2) : ['L0-V2.csv', 'L0-V5.csv', 'L0-V6.csv'])) {
  const rel = validar(B0, ler(lote), AMOSTRA);
  console.log(`\n=== ${lote}: verdict ${rel.veredito} (decided by rules, not by any model)`);
  const fixa = explicacaoFixa(rel);
  console.log(`fixed template : ${fixa}\n  lines ${linhasCitadas(fixa).join(', ')} · checker ${JSON.stringify(checarParecer(fixa, rel))}`);
  const ruim = `${fixa} Line 47 also looks suspicious.`; // canned bad text, not model output
  console.log(`canned bad text: checker ${JSON.stringify(checarParecer(ruim, rel))}`);
  if (!gerar) { console.log('model          : not configured (set GEMINI_API_KEY to compare)'); continue; }
  try {
    const t = await gerar(rel, B0);
    console.log(`model          : ${t}\n  lines ${linhasCitadas(t).join(', ')} · checker ${JSON.stringify(checarParecer(t, rel))}`);
  } catch (e) { console.log(`model          : unavailable (${e.message})`); }
}
