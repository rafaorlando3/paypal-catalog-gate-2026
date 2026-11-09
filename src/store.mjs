// File persistence for the order table: one JSON document, written atomically (temp file, fsync, rename).
// Single writer across processes: the constructor takes an exclusive lock file holding the owner pid. The pid is written
// to a temp file first and the lock is created with link(), which fails if the lock exists, so a lock file is never
// seen half-written by this code. A second process on the same data directory fails at startup (STORE_LOCKED).
// Takeover is fail-closed: only a lock whose content is a valid positive pid of a process proven dead (kill(pid, 0)
// answers ESRCH) is removed. Empty, invalid or ambiguous content keeps STORE_LOCKED and the file is left in place.
// Per-order locks live in the owning process (src/pedido.mjs).
import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, mkdirSync, existsSync, unlinkSync, linkSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PID = /^[1-9][0-9]{0,9}$/;
/** 'dead' only when the pid is valid and the OS says no such process; anything else is not proof. */
function estadoDono(conteudo) {
  if (!PID.test(conteudo)) return 'invalid';
  const pid = Number(conteudo);
  if (pid > 2147483647) return 'invalid'; // pid_t is a signed 32-bit integer
  try { process.kill(pid, 0); return 'alive'; } catch (e) { return e.code === 'ESRCH' ? 'dead' : 'alive'; }
}

export class StoreArquivo {
  constructor(caminho, { travar = true } = {}) {
    this.caminho = caminho; mkdirSync(dirname(caminho), { recursive: true });
    if (travar) this.#travar();
  }
  #travar() {
    const trava = `${this.caminho}.lock`;
    const bloqueado = (motivo) => { const err = new Error(`store ${this.caminho} is locked (${motivo}); only one writer may run`); err.codigo = 'STORE_LOCKED'; return err; };
    const tmp = join(dirname(this.caminho), `.lock.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, String(process.pid), { mode: 0o600 });
    const fd = openSync(tmp, 'r'); fsyncSync(fd); closeSync(fd);
    try {
      for (let i = 0; i < 2; i++) {
        try { linkSync(tmp, trava); this.trava = trava; break; }
        catch (e) {
          if (e.code !== 'EEXIST') throw e;
          let conteudo;
          try { conteudo = readFileSync(trava, 'utf8'); } catch (r) { if (r.code === 'ENOENT' && i === 0) continue; throw bloqueado('lock file unreadable'); }
          const estado = estadoDono(conteudo);
          if (estado === 'dead' && i === 0) { unlinkSync(trava); continue; }
          throw bloqueado(estado === 'alive' ? `by process ${conteudo}` : 'lock file without a valid pid; remove it by hand only after checking no writer runs');
        }
      }
      if (!this.trava) throw bloqueado('could not take the lock');
    } finally { try { unlinkSync(tmp); } catch {} }
    process.once('exit', () => this.soltar());
  }
  soltar() {
    if (!this.trava) return;
    try { if (readFileSync(this.trava, 'utf8') === String(process.pid)) unlinkSync(this.trava); } catch {}
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
