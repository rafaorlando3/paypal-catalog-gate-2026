// C3a browser regression for C3-01 (PREPARED, not executed in C3a; not part of `npm test`).
// Run only in the coordinated VPS/CI window, against a fixture-mode server:
//   PORT=8799 node src/servidor.mjs &   then   BASE=http://localhost:8799 node test/e2e/c3a-pedido-vinculo.e2e.cjs
// Needs Playwright with Chromium. Exit code 0 = every dependency change hid the obsolete request text.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8799';
const falhas = [];
const conferir = (cond, msg) => { if (!cond) falhas.push(msg); };

(async () => {
  const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
  const erros = []; pg.on('pageerror', (e) => erros.push(String(e))); pg.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  const texto = () => pg.textContent('#pedidoTxt');
  const montar = async (idioma) => {
    await pg.selectOption('#idioma', idioma); await pg.click('#montarPedido');
    await pg.waitForFunction(() => document.getElementById('pedidoTxt').textContent.length > 0);
  };
  const novoPedido = async () => { await pg.click('#novo'); await pg.waitForFunction(() => document.getElementById('ordem').textContent.includes('Order')); };
  const entregar = async (lote) => {
    const antes = await pg.textContent('#relatorio');
    await pg.selectOption('#lote', lote); await pg.click('#entregar');
    await pg.waitForFunction((a) => { const t = document.getElementById('relatorio').textContent; return t !== a && t.includes('FAIL'); }, antes);
  };
  const sugerir = async () => { await pg.click('#sugerir'); await pg.waitForSelector('#sugOut table'); };

  await pg.goto(`${BASE}/`);
  await novoPedido(); await entregar('C3-V7-dev-es.csv'); await sugerir();

  // 1. Fresh build survives the render that follows the action.
  await montar('es');
  conferir((await texto()).includes('Pedido de nueva entrega'), 'fresh ES request not shown after Build');

  // 2. Language change hides it; rebuilding shows the PT text.
  await pg.selectOption('#idioma', 'pt');
  conferir((await texto()) === '', 'ES text still visible after switching to PT');
  await montar('pt');
  conferir((await texto()).includes('Pedido de nova entrega'), 'PT request not shown after rebuild');

  // 3. Accepting a suggestion hides it.
  await pg.selectOption('#sugOut select[data-sid="rejeicao:20:stock"]', 'b1');
  await pg.waitForFunction(() => document.querySelector('#sugOut select[data-sid="rejeicao:20:stock"]')?.value === 'b1');
  conferir((await texto()) === '', 'request still visible after a decision changed');
  await montar('pt');
  conferir((await texto()).includes('usar exatamente este valor:\n    12'), 'accepted exact value missing after rebuild');

  // 4. A new delivered lot hides it.
  await pg.click('#reentrega'); await entregar('C3-V8-dev-pt.csv');
  conferir((await texto()) === '', 'request still visible after a new lot was delivered');

  // 5. Another order hides it.
  await sugerir(); await montar('es');
  await novoPedido();
  conferir((await texto()) === '', 'request still visible after switching to a new order');

  conferir(erros.length === 0, `browser errors: ${erros.join(' | ')}`);
  await b.close();
  console.log(JSON.stringify({ ok: falhas.length === 0, falhas }));
  process.exit(falhas.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
