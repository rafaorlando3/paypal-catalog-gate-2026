const $ = (id) => document.getElementById(id);
let id = location.hash.slice(1) || null, info = null, atual = null, csrf = '';
const api = async (path, opt = {}) => {
  const headers = { 'content-type': opt.raw ? 'text/csv' : 'application/json' };
  if (opt.method === 'POST') headers['x-cg-csrf'] = csrf; // per-session token; the server also checks Origin
  const r = await fetch(path, { ...opt, headers, credentials: 'same-origin', body: opt.raw ?? (opt.body ? JSON.stringify(opt.body) : opt.method === 'POST' ? '{}' : undefined) });
  const j = await r.json(); if (!r.ok) throw new Error(j.erro || r.status); return j;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COR = { verde: 'PASS', amarelo: 'PASS WITH REJECTIONS', vermelho: 'FAIL' };

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
  $('avisos').innerHTML = (p?.avisos || []).concat((p?.alertas || []).map((a) => a.msg)).map((a) => `<p class="warn">${esc(a)}</p>`).join('');
  const amarelo = p?.estado === 'CHECKED' && p.cor === 'amarelo';
  $('liBox').hidden = !amarelo; $('liTxt').textContent = amarelo ? `I read the ${r.rejeicoes.length} rejected rows and accept the delivery.` : '';
  $('capturar').disabled = !(p?.captura_disponivel) || (amarelo && !$('li').checked);
  $('autorizar').hidden = !(info?.modo === 'sandbox' && p?.estado === 'CREATED');
  $('reenviar').hidden = !(p?.estado === 'UNCERTAIN' && p.incerto && p.incerto !== 'capture');
  $('estado').textContent = p ? `State: ${p.estado}${p.capture_id ? ` · capture ${p.capture_id}` : ''}` : '';
  $('trilha').textContent = (p?.trilha || []).map((t) => `${t.t}  ${t.estado.padEnd(18)} ${t.evento}${t.motivo ? ` (${t.motivo})` : ''}${t.msg ? ` (${t.msg})` : ''}`).join('\n');
}
async function agir(fn) { try { render(await fn()); } catch (e) { $('erro').innerHTML = `<p class="err">${esc(e.message)}</p>`; } }

(async () => {
  info = await api('/api/info'); csrf = info.csrf;
  $('loginBox').hidden = !(info.login_exigido && !info.operador);
  $('modo').textContent = info.modo === 'sandbox' ? 'PayPal SANDBOX (test money)' : 'FIXTURE: simulated PayPal responses, no receipt';
  $('brief').innerHTML = `Columns: ${info.brief.colunas.map((c) => `<code>${c.nome}</code>`).join(', ')} · ${info.brief.linhas_esperadas} rows · tolerance ${info.brief.tolerancia_rejeicao * 100}% · key <code>${info.brief.chave}</code> · approved sample: data lines 2 to 11.`;
  $('lote').innerHTML = info.lotes.map((n) => `<option>${n}</option>`).join('');
  if (id) agir(() => api(`/api/pedidos/${id}`));
})();
$('novo').onclick = () => agir(async () => { const p = await api('/api/pedidos', { method: 'POST' }); id = p.id; location.hash = id; return p; });
$('entregar').onclick = () => agir(() => api(`/api/pedidos/${id}/entrega?lote=${encodeURIComponent($('lote').value)}`, { method: 'POST' }));
$('arquivo').onchange = async (e) => { const f = e.target.files[0]; if (f) agir(async () => api(`/api/pedidos/${id}/entrega`, { method: 'POST', raw: await f.text() })); };
$('parecer').onclick = () => agir(() => api(`/api/pedidos/${id}/parecer`, { method: 'POST', body: {} }));
$('li').onchange = () => render(atual);
$('capturar').onclick = () => agir(() => api(`/api/pedidos/${id}/capturar`, { method: 'POST', body: { confirmo: true, li_rejeicoes: $('li').checked } }));
$('reentrega').onclick = () => agir(() => api(`/api/pedidos/${id}/reentrega`, { method: 'POST', body: {} }));
$('anular').onclick = () => agir(() => api(`/api/pedidos/${id}/anular`, { method: 'POST', body: { confirmo: true } }));
$('reconciliar').onclick = () => agir(() => api(`/api/pedidos/${id}/reconciliar`, { method: 'POST', body: {} }));
$('reautorizar').onclick = () => agir(() => api(`/api/pedidos/${id}/reautorizar`, { method: 'POST', body: { confirmo: true } }));
$('reenviar').onclick = () => agir(() => api(`/api/pedidos/${id}/reenviar`, { method: 'POST', body: { confirmo: true } }));
$('autorizar').onclick = () => agir(() => api(`/api/pedidos/${id}/autorizar`, { method: 'POST', body: {} }));
$('entrar').onclick = async () => {
  try { const r = await api('/api/login', { method: 'POST', body: { token: $('token').value } }); csrf = r.csrf; $('token').value = ''; $('loginBox').hidden = true; if (id) agir(() => api(`/api/pedidos/${id}`)); }
  catch (e) { $('erro').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
};
