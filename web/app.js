const $ = (id) => document.getElementById(id);
// The selected order comes from the address (#id); a malformed escape is read literally instead of throwing.
function lerHash() { const h = location.hash.slice(1); try { return decodeURIComponent(h) || null; } catch { return h || null; } }
let id = lerHash(), info = null, atual = null, csrf = '';
let pedidoGerado = null; // C3a: { chave, texto } of the last built request; shown only while its dependencies are unchanged
const api = async (path, opt = {}) => {
  const headers = { 'content-type': opt.raw ? 'text/csv' : 'application/json' };
  if (opt.method === 'POST') headers['x-cg-csrf'] = csrf; // per-session token; the server also checks Origin
  const r = await fetch(path, { ...opt, headers, credentials: 'same-origin', body: opt.raw ?? (opt.body ? JSON.stringify(opt.body) : opt.method === 'POST' ? '{}' : undefined) });
  const j = await r.json(); if (!r.ok) throw new Error(j.erro || r.status); return j;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COR = { verde: 'PASS', amarelo: 'PASS WITH REJECTIONS', vermelho: 'FAIL' };

// C3a-U1: every network action carries a ticket taken when the person acts. Its answer may change the page (view, error,
// built request text, selected order, URL hash) only while it is still the latest intent for the selected order.
// A new-order intent, a change of the URL hash, any newer action and a language change advance these counters at once,
// before any network answer. Discarding an answer never cancels or reverses what the server already did: the page says
// so, never repeats a POST on its own, and a read-only reload (or Reconcile, by hand) shows the server's state.
const epoca = { selecao: 0, acao: 0, idioma: 0 };
const descartes = new Map(); // order id -> { acao, financeiro } when one of its POST answers was discarded
const pedidosNaoAbertos = []; // orders created by an earlier New click whose answer arrived too late to be opened
const NAO_ENVIADO = Symbol('superseded before sending'); // thrown when an action is superseded before its request left
function bilhete({ selecao = false, alvo = id, metodo = 'POST', novo = false, financeiro = false } = {}) {
  if (selecao) epoca.selecao++;
  epoca.acao++;
  return { selecao: epoca.selecao, acao: epoca.acao, idioma: epoca.idioma, idiomaValor: $('idioma').value, id: alvo, metodo, novo, financeiro };
}
const vigente = (t) => t.selecao === epoca.selecao && t.acao === epoca.acao && t.id === id;
const rota = (t, acao) => `/api/pedidos/${encodeURIComponent(t.id)}/${acao}`;
const exigirPedido = (t) => { if (!t.id) throw new Error('Create or open an order first.'); };

function avisosHtml(p) {
  const notas = (p?.avisos || []).concat((p?.alertas || []).map((a) => a.msg));
  const d = p?.id ? descartes.get(p.id) : null;
  if (d) notas.push(`An earlier answer for this order was discarded because a newer action was started. The server may still have applied that action${d.financeiro ? ', including a payment step (capture, void or authorization)' : ''}; nothing was retried. Reload the page to read the current state (read-only)${d.financeiro ? ', or use Reconcile' : ''}.`);
  if (pedidosNaoAbertos.length) notas.push(`Created by an earlier New click but not opened: order ${pedidosNaoAbertos.join(', order ')}. Open one by putting its id after # in the address.`);
  return notas.map((a) => `<p class="warn">${esc(a)}</p>`).join('');
}

function render(p) {
  atual = p; $('erro').innerHTML = '';
  $('ordem').textContent = p ? `Order ${p.order_id} · authorization ${p.autorizacao_id || 'pending buyer approval'}` : '';
  $('aprovar').innerHTML = p && p.estado === 'CREATED' && p.aprovacao_url ? `<p><a href="${esc(p.aprovacao_url)}">Approve with a PayPal sandbox buyer account</a></p>` : '';
  const r = p?.relatorio;
  if (r) {
    const linhas = [...r.rejeicoes.map((x) => `<tr><td>line ${x.linha}</td><td>${esc(x.campo)}</td><td>${esc(x.motivo)}</td></tr>`),
      ...r.duplicatas.map((d) => `<tr><td>lines ${d.linhas.join(', ')}</td><td>duplicate key</td><td>${esc(d.chave)}</td></tr>`),
      ...r.amostra.filter((a) => !a.confere).map((a) => `<tr><td>line ${a.linha}</td><td>approved sample · ${esc(a.campo)}</td><td>expected ${esc(a.esperado)}, received ${esc(a.recebido)}</td></tr>`)].join('');
    $('relatorio').innerHTML = `<p class="big v-${r.veredito}">${COR[r.veredito]}</p><p>Rows read ${r.lidas} · valid ${r.validas} (minimum ${r.minimo_validas}) · sample ${r.amostra.filter((a) => a.confere).length}/${r.amostra.length} · file sha256 <code>${r.lote_sha256.slice(0, 12)}…</code></p>${r.motivos.length ? `<p>Reasons: ${esc(r.motivos.join('; '))}</p>` : ''}${linhas ? `<table><thead><tr><th>Where</th><th>Field</th><th>Finding</th></tr></thead><tbody>${linhas}</tbody></table>` : ''}`;
  } else $('relatorio').textContent = 'No delivery yet.';
  const par = p?.parecer;
  $('parecerOut').innerHTML = par ? `<p class="${par.estado === 'accepted' ? '' : 'warn'}">${esc(par.estado === 'accepted' ? par.texto : par.estado === 'rejected' ? `Advisory rejected by the checker: ${par.motivo}` : 'Advisory unavailable. The rules above are unaffected.')}</p>` : '';
  $('avisos').innerHTML = avisosHtml(p);
  const sg = p?.sugestoes;
  $('iaEstado').textContent = sg ? `Rule-based suggestions (B1) always; AI: ${sg.ia.estado}${sg.ia.motivo ? ` (${sg.ia.motivo})` : ''}` : (info?.sugestoes_ia ? '' : 'AI suggestions are off in this build.');
  const prop = (x) => !x ? 'n/a' : x.acao === 'corrigir' ? `"${x.valor}"` : 'ask the supplier';
  $('sugOut').innerHTML = sg ? `<table><thead><tr><th>Where</th><th>Received</th><th>Rule-based</th><th>AI (checked)</th><th>Use in request</th></tr></thead><tbody>${sg.itens.map((it) => {
    const opIA = it.ia && it.ia.aceita_pelo_checador && it.ia.acao === 'corrigir';
    const atual = it.decisao?.aceitar ? it.decisao.fonte : '';
    return `<tr><td>line ${it.linha} · ${esc(it.campo)}</td><td><code>${esc(it.original)}</code></td><td>${esc(prop(it.b1))}</td><td>${it.ia ? `${esc(prop(it.ia))}${it.ia.aceita_pelo_checador ? (it.ia.semantica ? ' · word reading, check it' : '') : ` · refused: ${esc(it.ia.motivo_recusa)}`}` : '-'}</td><td><select data-sid="${esc(it.sid)}" aria-label="Use in request"><option value="">generic request</option>${it.b1.acao === 'corrigir' ? `<option value="b1"${atual === 'b1' ? ' selected' : ''}>rule-based value</option>` : ''}${opIA ? `<option value="ia"${atual === 'ia' ? ' selected' : ''}>AI value</option>` : ''}</select></td></tr>`;
  }).join('')}</tbody></table>` : '';
  for (const el of document.querySelectorAll('#sugOut select')) el.onchange = () => agir((t) => { exigirPedido(t); return api(rota(t, 'decidir_sugestao'), { method: 'POST', body: { sid: el.dataset.sid, fonte: el.value || undefined, aceitar: !!el.value, confirmo: true } }); });
  // C3a: the request text is derived from its binding on every render, never left over from an earlier state.
  const textoPedido = VinculoReentrega.textoVisivel(pedidoGerado, p, $('idioma').value);
  if (!textoPedido) pedidoGerado = null;
  $('pedidoTxt').textContent = textoPedido;
  const amarelo = p?.estado === 'CHECKED' && p.cor === 'amarelo';
  $('liBox').hidden = !amarelo; $('liTxt').textContent = amarelo ? `I read the ${r.rejeicoes.length} rejected rows and accept the delivery.` : '';
  $('capturar').disabled = !(p?.captura_disponivel) || (amarelo && !$('li').checked);
  $('autorizar').hidden = !(info?.modo === 'sandbox' && p?.estado === 'CREATED');
  $('estado').textContent = p ? `State: ${p.estado}${p.capture_id ? ` · capture ${p.capture_id}` : ''}` : '';
  $('trilha').textContent = (p?.trilha || []).map((t) => `${t.t}  ${t.estado.padEnd(18)} ${t.evento}${t.motivo ? ` (${t.motivo})` : ''}${t.msg ? ` (${t.msg})` : ''}`).join('\n');
}
const mostrarErro = (e) => { $('erro').innerHTML = `<p class="err">${esc(e && e.message)}</p>`; };

/** An answer that is no longer the latest intent changes nothing on the page except the discarded-answer notice. */
function descartar(t, resposta, erro) {
  if (t.metodo !== 'POST' || erro === NAO_ENVIADO) return; // a GET changes nothing; an unsent request did nothing
  if (t.novo) { if (resposta?.id && !pedidosNaoAbertos.includes(resposta.id)) pedidosNaoAbertos.push(resposta.id); }
  else if (t.id) descartes.set(t.id, { acao: epoca.acao, financeiro: t.financeiro || !!descartes.get(t.id)?.financeiro });
  $('avisos').innerHTML = avisosHtml(atual); // notice only: no re-render, so a current error or view is kept
}
async function agir(fn, { selecao = false, metodo = 'POST', novo = false, financeiro = false, alvo = id, aceitar = null } = {}) {
  const t = bilhete({ selecao, alvo, metodo, novo, financeiro });
  let r;
  try { r = await fn(t); } catch (e) { if (!vigente(t)) return descartar(t, undefined, e); return mostrarErro(e); }
  if (!vigente(t)) return descartar(t, r);
  if (aceitar) aceitar(r, t);
  // A read started after a discarded answer shows the server's current state again.
  if (t.metodo === 'GET' && r?.id && descartes.has(r.id) && t.acao > descartes.get(r.id).acao) descartes.delete(r.id);
  render(r);
}

(async () => {
  info = await api('/api/info'); csrf = info.csrf;
  $('loginBox').hidden = !(info.login_exigido && !info.operador);
  $('modo').textContent = info.modo === 'sandbox' ? 'PayPal SANDBOX (test money)' : 'FIXTURE: simulated PayPal responses, no receipt';
  $('brief').innerHTML = `Columns: ${info.brief.colunas.map((c) => `<code>${c.nome}</code>`).join(', ')} · ${info.brief.linhas_esperadas} rows · tolerance ${info.brief.tolerancia_rejeicao * 100}% · key <code>${info.brief.chave}</code> · approved sample: data lines 2 to 11.`;
  $('lote').innerHTML = info.lotes.map((n) => `<option>${n}</option>`).join('');
  // The initial read is not a person's intent: it must not supersede a click made while /api/info was loading.
  if (id && epoca.acao === 0) agir((t) => api(`/api/pedidos/${encodeURIComponent(t.id)}`), { metodo: 'GET' });
})();
// New-order intent supersedes every pending answer at the click. The selected order and the URL change only when
// this creation is still the latest intent; a late creation is listed as "not opened", never auto-selected.
$('novo').onclick = () => agir(() => api('/api/pedidos', { method: 'POST' }), {
  selecao: true, novo: true,
  aceitar: (p) => { id = p.id; pedidoGerado = null; if (location.hash.slice(1) !== id) location.hash = id; },
});
// Back/forward or an edited address selects another order: pending answers are superseded and the view is cleared
// until the read-only GET of the new selection answers, so no action can target one order while showing another.
window.addEventListener('hashchange', () => {
  const alvo = lerHash();
  if (alvo === id) return; // our own hash update after a creation
  id = alvo; pedidoGerado = null; render(null);
  if (alvo) agir((t) => api(`/api/pedidos/${encodeURIComponent(t.id)}`), { selecao: true, metodo: 'GET', alvo });
  else { epoca.selecao++; epoca.acao++; }
});
$('entregar').onclick = () => agir((t) => { exigirPedido(t); return api(`${rota(t, 'entrega')}?lote=${encodeURIComponent($('lote').value)}`, { method: 'POST' }); });
$('arquivo').onchange = (e) => {
  const f = e.target.files[0];
  if (f) agir(async (t) => {
    exigirPedido(t);
    const texto = await f.text();
    if (!vigente(t)) throw NAO_ENVIADO; // superseded while reading the file: the upload is not sent at all
    return api(rota(t, 'entrega'), { method: 'POST', raw: texto });
  });
};
$('parecer').onclick = () => agir((t) => { exigirPedido(t); return api(rota(t, 'parecer'), { method: 'POST', body: {} }); });
$('li').onchange = () => render(atual);
$('capturar').onclick = () => agir((t) => { exigirPedido(t); return api(rota(t, 'capturar'), { method: 'POST', body: { confirmo: true, li_rejeicoes: $('li').checked } }); }, { financeiro: true });
$('reentrega').onclick = () => agir((t) => { exigirPedido(t); return api(rota(t, 'reentrega'), { method: 'POST', body: {} }); });
$('anular').onclick = () => agir((t) => { exigirPedido(t); return api(rota(t, 'anular'), { method: 'POST', body: { confirmo: true } }); }, { financeiro: true });
$('reconciliar').onclick = () => agir((t) => { exigirPedido(t); return api(rota(t, 'reconciliar'), { method: 'POST', body: {} }); });
$('reautorizar').onclick = () => agir((t) => { exigirPedido(t); return api(rota(t, 'reautorizar'), { method: 'POST', body: { confirmo: true } }); }, { financeiro: true });
$('autorizar').onclick = () => agir((t) => { exigirPedido(t); return api(rota(t, 'autorizar'), { method: 'POST', body: {} }); }, { financeiro: true });
$('entrar').onclick = async () => {
  try { const r = await api('/api/login', { method: 'POST', body: { token: $('token').value } }); csrf = r.csrf; $('token').value = ''; $('loginBox').hidden = true; if (id) agir((t) => api(`/api/pedidos/${encodeURIComponent(t.id)}`), { metodo: 'GET' }); }
  catch (e) { mostrarErro(e); }
};
$('sugerir').onclick = () => agir((t) => { exigirPedido(t); return api(rota(t, 'sugerir'), { method: 'POST', body: {} }); });
// The built text is kept only if, besides being the latest action, no language change happened while it was in flight
// (changing away and back advances the language counter, so the old completion cannot come back by value alone).
$('montarPedido').onclick = () => agir((t) => { exigirPedido(t); return api(rota(t, 'pedido_reentrega'), { method: 'POST', body: { idioma: t.idiomaValor } }); }, {
  aceitar: (r, t) => { if (t.idioma === epoca.idioma && t.idiomaValor === $('idioma').value) pedidoGerado = VinculoReentrega.gerado(r); },
});
// A language change invalidates any request text and any build still in flight; the view itself is re-rendered as is.
$('idioma').onchange = () => { epoca.idioma++; pedidoGerado = null; render(atual); };
