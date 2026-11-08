// File persistence for the order table: one JSON document, written atomically (temp file, fsync, rename).
// Single process by design: the per-order locks live in that process.
import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class StoreArquivo {
  constructor(caminho) { this.caminho = caminho; mkdirSync(dirname(caminho), { recursive: true }); }
  ler() {
    if (!existsSync(this.caminho)) return null;
    const d = JSON.parse(readFileSync(this.caminho, 'utf8'));
    if (d.versao !== 1) throw new Error(`unknown store version ${d.versao}`);
    return d;
  }
  gravar(estado) {
    const tmp = join(dirname(this.caminho), `.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, JSON.stringify(estado), { mode: 0o600 });
    const fd = openSync(tmp, 'r'); fsyncSync(fd); closeSync(fd);
    renameSync(tmp, this.caminho);
  }
}

/** In-memory store with the same interface, for tests (simulates a restart by sharing the object). */
export class StoreMemoria {
  constructor() { this.dados = null; }
  ler() { return this.dados ? JSON.parse(this.dados) : null; }
  gravar(estado) { this.dados = JSON.stringify(estado); }
}
