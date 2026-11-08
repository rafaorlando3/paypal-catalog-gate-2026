// Deterministic catalog lots for the R1 scenarios (no network, stdlib only).
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const HEADER = 'sku,nombre,precio,stock';
export function rowL0(n) {
  const precio = (((n * 37) % 9000) + 100) / 100;
  return `ABC-${String(n).padStart(4, '0')},Producto ${String(n).padStart(3, '0')},${precio.toFixed(2)},${(n * 7) % 50}`;
}
const lines = (rows, header = HEADER) => [header, ...rows].join('\n') + '\n';
export function lots() {
  const base = Array.from({ length: 200 }, (_, i) => rowL0(i + 1));
  const v2 = base.map((r, i) => ([45, 120, 177].includes(i + 1) ? r.split(',').map((c, j) => (j === 2 ? '' : c)).join(',') : r));
  const v5 = base.slice(); const p = v5[149].split(','); p[0] = 'ABC-0042'; v5[149] = p.join(',');
  const v6 = base.slice(); v6[4] = v6[4].replace(',2.85,', ',2.58,');
  return {
    'L0.csv': lines(base),
    'L0-V2.csv': lines(v2),
    'L0-V4.csv': lines(base, 'sku,nombre,precioo,stock'),
    'L0-V5.csv': lines(v5),
    'L0-V6.csv': lines(v6),
    'AMOSTRA-L0-linhas-2-11.csv': base.slice(0, 10).join('\n') + '\n',
  };
}
export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || 'fixtures/L0'; mkdirSync(dir, { recursive: true });
  for (const [name, txt] of Object.entries(lots())) { writeFileSync(join(dir, name), txt); console.log(sha256(txt), Buffer.byteLength(txt), name); }
}
