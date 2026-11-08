// File persistence for the order table: one JSON document, written atomically (temp file, fsync, rename).
// Single writer across processes: the constructor takes an exclusive lock file (O_CREAT|O_EXCL) holding the owner pid.
// A second process on the same data directory fails at startup instead of sending a duplicate request; a lock left by a
// dead process is taken over. Per-order locks live in the owning process (src/pedido.mjs).
import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

const vivo = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export class StoreArquivo {
  constructor(caminho, { travar = true } = {}) {
    this.caminho = caminho; mkdirSync(dirname(caminho), { recursive: true });
    if (travar) this.#travar();
  }
  #travar() {
    this.trava = `${this.caminho}.lock`;
    for (let i = 0; i < 2; i++) {
      try { const fd = openSync(this.trava, 'wx', 0o600); writeFileSync(fd, String(process.pid)); fsyncSync(fd); closeSync(fd); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const dono = Number(readFileSync(this.trava, 'utf8'));
        if (i === 0 && !vivo(dono)) { unlinkSync(this.trava); continue; }
        const err = new Error(`store ${this.caminho} is locked by process ${dono}; only one writer may run`); err.codigo = 'STORE_LOCKED'; throw err;
      }
    }
    const soltar = () => this.soltar();
    process.once('exit', soltar);
  }
  soltar() {
    if (!this.trava) return;
    try { if (Number(readFileSync(this.trava, 'utf8')) === process.pid) unlinkSync(this.trava); } catch {}
    this.trava = null;
  }
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
