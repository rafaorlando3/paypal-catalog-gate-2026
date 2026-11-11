// C3a-U1 browser regression: late and out-of-order network answers (PREPARED, not executed; not part of `npm test`).
// Run only in the coordinated VPS/CI window, against a fresh fixture-mode server (simulated PayPal, no AI provider):
//   PORT=8799 node src/servidor.mjs &   then   BASE=http://localhost:8799 node test/e2e/c3au1-respostas-atrasadas.e2e.cjs
// Needs Playwright with Chromium. Exit 0 = all seven scenarios hold. Each scenario uses its own browser context
// (its own session). An answer is held with route.fetch(): the request reaches the server at once and the server
// applies it, only the answer is delayed, which is the case where the UI must not undo or repeat anything.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8799';
const resultado = {};

async function cenario(b, nome, corpo) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const pg = await ctx.newPage();
  const falhas = []; const posts = []; const erros = []; const retidos = [];
  const comPrazo = (promessa, rotulo, ms = 15000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout (${ms}ms): ${rotulo}`)), ms);
    promessa.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
  pg.on('pageerror', (e) => erros.push(String(e)));
  pg.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  pg.on('request', (r) => { if (r.method() === 'POST') posts.push(new URL(r.url()).pathname); });
  const h = {
    pg, posts, conferir: (cond, msg) => { if (!cond) falhas.push(msg); },
    texto: (sel) => pg.textContent(sel), html: (sel) => pg.innerHTML(sel),
    hash: () => pg.evaluate(() => decodeURIComponent(location.hash.slice(1))),
    assentar: () => pg.waitForTimeout(300),
    /** Read-only server state, outside the page logic (same session cookie). */
    servidor: async (id) => (await pg.request.get(`${BASE}/api/pedidos/${encodeURIComponent(id)}`)).json(),
    async novo() {
      const idAntes = await h.hash();
      const [resp] = await Promise.all([pg.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/pedidos'), pg.click('#novo')]);
      if (!resp.ok()) throw new Error(`POST /api/pedidos HTTP ${resp.status()}`);
      const p = await resp.json();
      if (!p || typeof p.id !== 'string' || !p.id || typeof p.order_id !== 'string' || !p.order_id) {
        throw new Error('POST /api/pedidos invalid body');
      }
      if (p.id === idAntes) throw new Error(`POST /api/pedidos returned unchanged order id ${p.id}`);
      await pg.waitForFunction(
        ({ idEsperado, oidEsperado }) => decodeURIComponent(location.hash.slice(1)) === idEsperado && (document.getElementById('ordem')?.textContent || '').includes(oidEsperado),
        { idEsperado: p.id, oidEsperado: p.order_id }
      );
      return p;
    },
    async abrirHash(idEsperado) {
      const alvoPath = `/api/pedidos/${encodeURIComponent(idEsperado)}`;
      const [resp] = await Promise.all([
        pg.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname === alvoPath),
        pg.evaluate((id) => { location.hash = id; }, idEsperado),
      ]);
      if (!resp.ok()) throw new Error(`GET ${alvoPath} HTTP ${resp.status()}`);
      const p = await resp.json();
      if (!p || p.id !== idEsperado || typeof p.order_id !== 'string' || !p.order_id) {
        throw new Error(`GET ${alvoPath} invalid body`);
      }
      await pg.waitForFunction(
        ({ id, oid }) => decodeURIComponent(location.hash.slice(1)) === id && (document.getElementById('ordem')?.textContent || '').includes(oid),
        { id: p.id, oid: p.order_id }
      );
      return p;
    },
    async recarregar(idEsperado) {
      const alvoPath = `/api/pedidos/${encodeURIComponent(idEsperado)}`;
      const [resp] = await Promise.all([
        pg.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname === alvoPath),
        pg.reload(),
      ]);
      if (!resp.ok()) throw new Error(`reload GET ${alvoPath} HTTP ${resp.status()}`);
      const p = await resp.json();
      if (!p || p.id !== idEsperado || typeof p.order_id !== 'string' || !p.order_id) {
        throw new Error(`reload GET ${alvoPath} invalid body`);
      }
      await pg.waitForFunction(
        ({ id, oid }) => decodeURIComponent(location.hash.slice(1)) === id && (document.getElementById('ordem')?.textContent || '').includes(oid),
        { id: p.id, oid: p.order_id }
      );
      return p;
    },
    async vigiarSemMutacao() {
      await pg.evaluate(() => {
        if (window.__u1Obs) window.__u1Obs.disconnect();
        window.__u1Mutacoes = 0;
        const obs = new MutationObserver((lista) => { window.__u1Mutacoes += lista.length; });
        for (const id of ['ordem', 'estado', 'trilha', 'relatorio', 'pedidoTxt']) {
          const el = document.getElementById(id);
          if (el) obs.observe(el, { childList: true, characterData: true, subtree: true });
        }
        window.__u1Obs = obs;
      });
      return () => pg.evaluate(() => {
        if (window.__u1Obs) { window.__u1Obs.disconnect(); delete window.__u1Obs; }
        return window.__u1Mutacoes || 0;
      });
    },
    async acao(botao, sufixo) {
      await Promise.all([pg.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(sufixo)), pg.click(botao)]);
      await h.assentar();
    },
    async entregar(lote) { await pg.selectOption('#lote', lote); await h.acao('#entregar', '/entrega'); },
    async sugerir() { await h.acao('#sugerir', '/sugerir'); await pg.waitForSelector('#sugOut table'); },
    /**
     * Holds the next API request that matches. 'servidor': the request is applied by the server now and only its answer
     * is held. Otherwise the request never reaches the server and is answered with an error carrying that text.
     */
    async segurar(filtro, modo = 'servidor') {
      let abrirLiberado, chegouOk, chegouErro, fimOk, fimErro, resposta, corpoJson;
      let reivindicado = false, solto = false, desregistrado = false, rotaCapturada = null;
      const liberado = new Promise((r) => { abrirLiberado = r; });
      const chegadaBruta = new Promise((res, rej) => { chegouOk = res; chegouErro = rej; });
      const concluidoBruto = new Promise((res, rej) => { fimOk = res; fimErro = rej; });
      chegadaBruta.catch(() => {});
      concluidoBruto.catch(() => {});
      const handler = async (route) => {
        if (reivindicado || !filtro(route.request())) return route.fallback();
        reivindicado = true;
        rotaCapturada = route;
        try {
          if (modo === 'servidor') {
            resposta = await route.fetch();
            const st = resposta.status();
            if (st < 200 || st >= 300) throw new Error(`unexpected held HTTP ${st} for ${route.request().url()}`);
            corpoJson = await resposta.json();
            chegouOk();
            await liberado;
            await route.fulfill({ response: resposta });
          } else {
            chegouOk();
            await liberado;
            await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ erro: modo }) });
          }
          fimOk();
        } catch (e) {
          chegouErro(e);
          fimErro(e);
        }
      };
      const removerRota = async () => {
        if (!desregistrado) {
          desregistrado = true;
          await pg.unroute('**/api/**', handler);
        }
      };
      const item = {
         get solto() { return solto; },
        encerrarForcado: async () => {
          if (!solto) {
            falhas.push(`unreleased hold in ${nome} (${modo})`);
            solto = true;
            if (!reivindicado) {
              chegouErro(new Error('hold never matched any request'));
              fimOk();
            } else {
              abrirLiberado();
            }
          }
          try {
            if (reivindicado) await comPrazo(concluidoBruto, `hold cleanup ${nome}`, 5000);
          } catch (e) {
            falhas.push(`hold error in ${nome}: ${e && e.message || e}`);
            if (rotaCapturada) await rotaCapturada.abort().catch(() => {});
          } finally {
            await removerRota().catch(() => {});
          }
        },
      };
      retidos.push(item);
      await pg.route('**/api/**', handler);
      return {
        get chegada() { return comPrazo(chegadaBruta, `hold arrival (${modo})`); },
        soltar: async () => {
          solto = true;
          abrirLiberado();
          try {
            await comPrazo(concluidoBruto, `hold completion (${modo})`);
          } finally {
            await removerRota();
          }
          await h.assentar();
        },
        json: async () => structuredClone(corpoJson),
      };
    },
  };
  const caminho = (fim) => (r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith(fim);
  try {
    await pg.goto(`${BASE}/`);
    await corpo(h, caminho);
  } catch (e) {
    falhas.push(`exception: ${e && e.stack || e}`);
  } finally {
    for (const r of retidos) await r.encerrarForcado();
  }
  if (erros.length) falhas.push(`browser errors: ${erros.join(' | ')}`);
  resultado[nome] = { ok: falhas.length === 0, falhas, posts };
  await ctx.close();
}

(async () => {
  const b = await chromium.launch();

  await cenario(b, 'U1-01', async (h, caminho) => {
    const A = await h.novo(); await h.entregar('C3-V7-dev-es.csv'); await h.sugerir();
    await h.pg.selectOption('#idioma', 'es');
    const build = await h.segurar(caminho('/pedido_reentrega'));
    await h.pg.click('#montarPedido'); await build.chegada;
    const B = await h.novo();
    const antes = h.posts.length;
    const lerMutacoes = await h.vigiarSemMutacao();
    await build.soltar();
    h.conferir(await lerMutacoes() === 0, 'late A build mutated the rendered view of B');
    h.conferir(await h.hash() === B.id, 'hash moved away from B');
    h.conferir((await h.texto('#ordem')).includes(B.order_id), 'view is not B');
    h.conferir(await h.texto('#pedidoTxt') === '', 'A request text appeared on B');
    h.conferir(await h.html('#erro') === '', 'an error appeared');
    h.conferir((await h.texto('#relatorio')) === 'No delivery yet.', 'A report shown on B');
    h.conferir(h.posts.length === antes, 'the late answer caused another request');
    h.conferir(JSON.stringify(h.posts) === JSON.stringify(['/api/pedidos', `/api/pedidos/${A.id}/entrega`, `/api/pedidos/${A.id}/sugerir`, `/api/pedidos/${A.id}/pedido_reentrega`, '/api/pedidos']), `unexpected POSTs ${h.posts}`);
  });

  await cenario(b, 'U1-02', async (h) => {
    const novoA = await h.segurar((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/pedidos');
    await h.pg.click('#novo'); await novoA.chegada;
    const B = await h.novo();
    const A = await novoA.json();
    const lerMutacoes = await h.vigiarSemMutacao();
    await novoA.soltar();
    const mutacoes = await lerMutacoes();
    h.conferir(A.id !== B.id, 'A and B received the same local id');
    h.conferir(await h.hash() === B.id, 'late New A changed the hash');
    const ordem = await h.texto('#ordem');
    h.conferir(ordem.includes(B.order_id) && mutacoes === 0, 'late New A rendered');
    h.conferir((await h.texto('#avisos')).includes(`not opened: order ${A.id}`), 'late order not listed as not opened');
    h.conferir(h.posts.length === 2, `unexpected POSTs ${h.posts}`);
  });

  await cenario(b, 'U1-03', async (h, caminho) => {
    // a) New B while a failing action of A is in flight.
    const A = await h.novo(); await h.entregar('C3-V7-dev-es.csv');
    let falha = await h.segurar(caminho('/sugerir'), 'STALE-A-FAILURE');
    await h.pg.click('#sugerir'); await falha.chegada;
    const B = await h.novo();
    await falha.soltar();
    h.conferir(await h.html('#erro') === '', 'stale A error shown on B');
    h.conferir((await h.texto('#ordem')).includes(B.order_id), 'B view replaced');
    // b) Navigate to A by address, start a failing action, navigate back to B, then the failure arrives.
    await h.abrirHash(A.id);
    falha = await h.segurar(caminho('/sugerir'), 'STALE-A-FAILURE-2');
    await h.pg.click('#sugerir'); await falha.chegada;
    await h.abrirHash(B.id);
    await falha.soltar();
    h.conferir(await h.html('#erro') === '', 'stale A error shown after navigating back to B');
    h.conferir((await h.texto('#ordem')).includes(B.order_id), 'B view replaced after navigation');
  });

  await cenario(b, 'U1-04', async (h, caminho) => {
    const A = await h.novo(); await h.entregar('C3-V7-dev-es.csv'); await h.sugerir();
    const antes = await h.servidor(A.id);
    const build = await h.segurar(caminho('/pedido_reentrega'));
    await h.pg.click('#montarPedido'); await build.chegada;
    await h.acao('#reentrega', '/reentrega'); await h.entregar('C3-V8-dev-pt.csv');
    await build.soltar();
    const depois = await h.servidor(A.id);
    h.conferir(await h.texto('#pedidoTxt') === '', 'revision 1 request text shown');
    h.conferir(depois.revisao_entrega > antes.revisao_entrega, 'second delivery not recorded');
    h.conferir(['posts_capture', 'posts_void', 'posts_reauth', 'capturas_ok'].every((k) => depois.contadores[k] === antes.contadores[k]) && depois.estado !== 'COMPLETED', 'payment counters or state changed');
    h.conferir(/earlier answer for this order was discarded/.test(await h.texto('#avisos')), 'discarded-answer notice missing');
    h.conferir(h.posts.filter((p) => p.endsWith('/pedido_reentrega')).length === 1, 'build re-sent');
  });

  await cenario(b, 'U1-05', async (h, caminho) => {
    await h.novo(); await h.entregar('C3-V7-dev-es.csv'); await h.sugerir();
    await h.pg.selectOption('#idioma', 'es');
    const build = await h.segurar(caminho('/pedido_reentrega'));
    await h.pg.click('#montarPedido'); await build.chegada;
    await h.pg.selectOption('#idioma', 'pt'); await h.pg.selectOption('#idioma', 'es');
    await build.soltar();
    h.conferir(await h.texto('#pedidoTxt') === '', 'obsolete ES build revived after ES -> PT -> ES');
    await h.acao('#montarPedido', '/pedido_reentrega');
    h.conferir((await h.texto('#pedidoTxt')).includes('Pedido de nueva entrega'), 'a fresh ES build is not shown');
  });

  await cenario(b, 'U1-06', async (h, caminho) => {
    for (const primeiro of ['parecer', 'captura']) {
      const A = await h.novo(); await h.entregar('L0.csv');
      await h.pg.waitForFunction(() => !document.getElementById('capturar').disabled);
      const cap = await h.segurar(caminho('/capturar'));
      await h.pg.click('#capturar'); await cap.chegada; // the server has captured; only the answer is held
      const par = await h.segurar(caminho('/parecer'));
      await h.pg.click('#parecer'); await par.chegada;
      if (primeiro === 'parecer') { await par.soltar(); await cap.soltar(); } else { await cap.soltar(); await par.soltar(); }
      const srv = await h.servidor(A.id);
      h.conferir(srv.contadores.posts_capture === 1 && srv.contadores.capturas_ok === 1, `${primeiro}: server capture count is not exactly one`);
      h.conferir((await h.texto('#trilha')).includes('advisory unavailable'), `${primeiro}: the latest intent did not govern the view`);
      h.conferir(/including a payment step/.test(await h.texto('#avisos')), `${primeiro}: financial discarded-answer notice missing`);
      h.conferir(h.posts.filter((p) => p === `/api/pedidos/${A.id}/capturar`).length === 1, `${primeiro}: capture re-sent`);
      h.conferir(!h.posts.some((p) => p.endsWith('/reconciliar') || p.endsWith('/anular') || p.endsWith('/reautorizar')), `${primeiro}: an automatic financial POST was sent`);
      // A read-only reload shows the server state and clears the notice.
      await h.recarregar(A.id);
      h.conferir(!/discarded/.test(await h.texto('#avisos')), `${primeiro}: notice survives a reload`);
      h.conferir((await h.texto('#estado')).includes(srv.estado), `${primeiro}: reloaded state differs from the server`);
    }
  });

  await cenario(b, 'U1-07', async (h, caminho) => {
    // No order yet: no request at all.
    await h.pg.click('#sugerir'); await h.assentar();
    h.conferir((await h.texto('#erro')).includes('Create or open an order first'), 'missing no-order message');
    h.conferir(h.posts.length === 0, 'a request was sent without an order');
    // Normal sequence, as in the C3a regression.
    const A = await h.novo(); await h.entregar('C3-V7-dev-es.csv'); await h.sugerir();
    await h.pg.selectOption('#idioma', 'es'); await h.acao('#montarPedido', '/pedido_reentrega');
    h.conferir((await h.texto('#pedidoTxt')).includes('Pedido de nueva entrega'), 'normal build not shown');
    // A failure of the current order is shown and keeps the view; the next success clears it.
    const falha = await h.segurar(caminho('/sugerir'), 'CURRENT-FAILURE');
    await h.pg.click('#sugerir'); await falha.chegada; await falha.soltar();
    h.conferir((await h.texto('#erro')).includes('CURRENT-FAILURE'), 'current failure not shown');
    h.conferir((await h.texto('#ordem')).includes(A.order_id) && (await h.texto('#relatorio')).includes('FAIL'), 'view lost on a current failure');
    await h.sugerir();
    h.conferir(await h.html('#erro') === '', 'error not cleared by the next success');
    h.conferir(!/discarded/.test(await h.texto('#avisos')), 'notice shown in a purely sequential flow');
    // Normal capture: exactly one capture POST and the state shown matches the server.
    const C = await h.novo(); await h.entregar('L0.csv');
    await h.pg.waitForFunction(() => !document.getElementById('capturar').disabled);
    await h.acao('#capturar', '/capturar');
    const srv = await h.servidor(C.id);
    h.conferir(srv.contadores.posts_capture === 1 && (await h.texto('#estado')).includes(srv.estado), 'normal capture view differs from the server');
  });

  await b.close();
  const ok = Object.values(resultado).every((r) => r.ok);
  console.log(JSON.stringify({ ok, resultado }, null, 1));
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
