// PREPARED ONLY. Run exclusively in reviewed, network-none CI, never on Mac.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = 'http://localhost:8799';
const data = JSON.parse(fs.readFileSync('/video/evidence.json','utf8'));
const check = (value, message) => { if (!value) throw new Error(message); };
check(process.env.MODE === 'fixture' && !process.env.GEMINI_API_KEY && !process.env.PAYPAL_CLIENT_ID && !process.env.PAYPAL_CLIENT_SECRET, 'Offline fixture only');
check(data.schema === 'catalog-gate-public-demo-evidence-v1' && data.real_sandbox_complete === true, 'Actual qualified Sandbox evidence required, no placeholder video');
check(data.product === 'e7955eda8e9413224a6b7541be40e5ede4638a57', 'Product pin');
check(data.ai.attempts === 2 && data.ai.answers === 1 && data.ai.second === 'advisory_timeout' && data.ai.third === 'not_attempted', 'Actual partial AI result only');
check(data.sandbox.capture.status === 'COMPLETED' && data.sandbox.capture.final_capture === true && data.sandbox.capture.amount === '50.00' && data.sandbox.capture.currency === 'USD', 'Full actual Sandbox capture required');
check(data.sandbox.webhook.signature_verified === true && data.sandbox.webhook.event_type === 'PAYMENT.CAPTURE.COMPLETED', 'Actual signed capture webhook required');
check(data.sandbox.human_exact_acceptance === true && data.sandbox.buyer_approved === true, 'Personal gates required');
// Evidence schema and its final strings are separately reviewed before CI.
const escape = (value) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const output = '/evidence';
const frames = [];
const requests = [];
const started = Date.now();
const hold = async (ms) => {
  check(Date.now()-started+ms < 170000, 'Video wall time would exceed 170 seconds');
  await new Promise(r => setTimeout(r,ms));
};
let server, browser, context;
const stop = async () => {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([new Promise(r => server.once('exit',r)),new Promise(r => setTimeout(r,4000))]);
  if (server.exitCode === null) { server.kill('SIGKILL'); await new Promise(r => server.once('exit',r)); }
};
try {
  fs.mkdirSync('/tmp/video-home',{recursive:true});
  server = spawn(process.execPath,['/product/src/servidor.mjs'],{cwd:'/product',env:{
    PATH:process.env.PATH,HOME:'/tmp/video-home',TMPDIR:'/tmp',LANG:'C.UTF-8',
    MODE:'fixture',PORT:'8799',BASE_URL:BASE,DATA_DIR:'/tmp/video-fixture-state',
  },stdio:['ignore','ignore','ignore']});
  server.on('error', () => {});
  for (let i=0;i<40;i++) {
    try { const r = await fetch(BASE+'/api/info'); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r,100));
  }
  browser = await chromium.launch();
  context = await browser.newContext({viewport:{width:1280,height:720},recordVideo:{dir:output,size:{width:1280,height:720}}});
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('dialog', dialog => dialog.dismiss()); // no automatic acceptance, even in the fixture recording
  page.on('request',request => {
    const u = new URL(request.url());
    if (['http:','https:'].includes(u.protocol)) requests.push({method:request.method(),host:u.hostname,path:u.pathname});
  });
  const caption = async text => page.evaluate(text => {
    let el = document.getElementById('video-caption');
    if (!el) { el=document.createElement('div');el.id='video-caption';document.body.appendChild(el); }
    Object.assign(el.style,{position:'fixed',left:'16px',right:'16px',bottom:'12px',zIndex:'2147483647',background:'#102536',color:'#fff',padding:'12px 18px',font:'20px/1.35 system-ui',borderRadius:'10px',pointerEvents:'none'});
    el.textContent=text;
  },text);
  const frame = async name => {
    const filename = name+'.png';await page.screenshot({path:path.join(output,filename)});frames.push(filename);
  };
  const slide = async (heading,body) => {
    await page.setContent('<!doctype html><html lang="en"><meta charset="utf-8"><style>body{background:#f5f7f9;color:#152535;font:23px/1.4 system-ui;margin:36px}h1{font-size:34px;margin:18px 0}p{max-width:1160px;margin:14px 0}.tag{font-size:17px;color:#4f6170}code{font-size:19px;overflow-wrap:anywhere}blockquote{background:#fff;border-left:6px solid #24629a;margin:16px 0;padding:14px;font-size:22px}</style><p class="tag">CATALOG GATE · PAYPAL AI HACKATHON</p><h1>'+escape(heading)+'</h1>'+body);
    check(await page.evaluate(()=>document.documentElement.scrollHeight<=720),'Slide text exceeds the recorded viewport');
  };
  await slide('Pay only after a verified catalog delivery','<p>A buyer orders a USD 50 catalog import. Deterministic rules check the delivery. AI explains the findings; a human accepts before full capture.</p><p>PayPal authorization and capture are not escrow.</p><p class="tag">Next: offline fixture demonstration, then recorded real AI and Sandbox evidence.</p>');
  await frame('01-introduction');await hold(10000);
  await page.goto(BASE);await page.waitForSelector('#novo');
  await page.waitForFunction(()=>Array.from(document.querySelector('#lote').options).some(x=>x.textContent==='L0-V2.csv'),null,{timeout:10000});
  await caption('OFFLINE FIXTURE: PayPal is simulated here. No real payment or API call.');await hold(3000);
  const clickPost = async (selector,endpoint) => {
    const [response] = await Promise.all([page.waitForResponse(r=>r.request().method()==='POST' && new URL(r.url()).pathname.endsWith(endpoint)),page.click(selector)]);
    check(response.ok(),'Fixture action failed');
    const result = await response.json();
    await page.waitForFunction(expected=>document.querySelector('#ordem').textContent.includes(expected.order_id) && document.querySelector('#estado').textContent.includes('State: '+expected.estado),result,{timeout:10000});
    check((await page.locator('#erro').innerText()).trim()==='','Fixture UI reports an error');
    return result;
  };
  await clickPost('#novo','/api/pedidos');
  await page.selectOption('#lote','L0-V2.csv');const rejected=await clickPost('#entregar','/entrega');
  check(rejected.cor==='amarelo' && rejected.relatorio.rejeicoes.length===3,'Expected three rejected price rows');
  await page.waitForFunction(()=>document.querySelector('#relatorio').textContent.includes('line 178'),null,{timeout:10000});
  await page.locator('#relatorio').scrollIntoViewIfNeeded();
  await caption('OFFLINE FIXTURE (simulated PayPal): three missing prices are cited by line; rules decide PASS WITH REJECTIONS.');
  await frame('02-fixture-findings');await hold(16000);
  await clickPost('#reentrega','/reentrega');await page.selectOption('#lote','L0-V5.csv');await clickPost('#entregar','/entrega');
  check(await page.locator('#capturar').isDisabled(),'Duplicate-key delivery must block capture');
  await caption('OFFLINE FIXTURE (simulated PayPal): duplicate keys fail the check; capture stays blocked and the supplier must redeliver.');
  await frame('03-fixture-blocked');await hold(14000);
  await clickPost('#novo','/api/pedidos');await page.selectOption('#lote','L0.csv');await clickPost('#entregar','/entrega');
  check(await page.locator('#capturar').isEnabled(),'Clean fixture should allow a human decision');
  await page.locator('#capturar').scrollIntoViewIfNeeded();
  await caption('OFFLINE FIXTURE (simulated PayPal): the clean file passes; this click simulates the human full-capture decision.');
  await frame('04-fixture-human-gate');await hold(9000);
  const captured = await clickPost('#capturar','/capturar');check(captured.estado==='CAPTURED','Fixture full capture state');
  await frame('05-fixture-captured');await hold(10000);
  await slide('Recorded real Gemini evaluation — 11 November','<blockquote>'+escape(data.ai.answer_text)+'</blockquote><p>Correct citations: lines 46, 121 and 178. One useful response; call 2 timed out at 15 s. Call 3 was not attempted. No retry.</p><p class="tag">Actual stored response, not a new call or a claim that all 3 cases passed. Rules and payment decisions remain independent of AI.</p>');
  await frame('06-actual-AI');await hold(25000);
  await slide('Actual PayPal Sandbox evidence','<p>Buyer approval → authorization → exact delivery acceptance → full capture.</p><p><b>USD 50.00 · COMPLETED · final_capture:true</b></p><p>Capture GET: <code>'+escape(data.sandbox.capture.id)+'</code></p><p>Signed capture webhook verified: <code>'+escape(data.sandbox.webhook.event_id)+'</code></p><p class="tag">Recorded receipts from the real Sandbox run. This video makes no PayPal or Gemini call. No live money.</p>');
  await frame('07-actual-Sandbox');await hold(25000);
  await slide('Open source, reproducible checks','<p>MIT-licensed code and setup instructions:</p><p><code>github.com/rafaorlando3/paypal-catalog-gate-2026</code></p><p>Qualified code: 111 unit tests, Chromium regressions and 7 out-of-order response scenarios passed. The demo preserves the financial core.</p><p><b>Rules decide. AI explains. Humans accept.</b></p>');
  await frame('08-repository');await hold(12000);
  check(requests.every(r=>r.host==='localhost' || r.host==='127.0.0.1'),'Unexpected browser request');
  const video = page.video();await context.close();context=null;
  const file = await video.path();check(file.endsWith('.webm') && path.dirname(file)===output,'Video path');
  const bytes = fs.readFileSync(file);check(bytes.length>10000 && bytes.length<=8*1024*1024,'Bounded video size');
  const validator = await browser.newPage();
  fs.writeFileSync(output+'/validate.html','<video id="clip" controls src="'+escape(path.basename(file))+'"></video>');
  await validator.goto('file:///evidence/validate.html');
  await validator.waitForFunction(()=>document.getElementById('clip').readyState>=1,null,{timeout:20000});
  const initialDuration = await validator.locator('#clip').evaluate(el=>el.duration);
  if (!Number.isFinite(initialDuration)) {
    await validator.locator('#clip').evaluate(el=>{ el.currentTime=1e9; });
  }
  await validator.waitForFunction(()=>Number.isFinite(document.getElementById('clip').duration) && document.getElementById('clip').duration>0,null,{timeout:20000});
  const duration = await validator.locator('#clip').evaluate(el=>el.duration);
  check(duration>=110 && duration<180,'Actual decoded video must be under 3 minutes');
  fs.renameSync(file,output+'/catalog-gate-demo.webm');
  fs.writeFileSync(output+'/video-report.json',JSON.stringify({actual_duration_seconds:duration,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),frames,requests,source:data.product,no_real_provider_calls_in_CI:true,fixture_labeled:true},null,2));
  await browser.close();browser=null;await stop();
} finally {
  if(context)await context.close().catch(()=>{});
  if(browser)await browser.close().catch(()=>{});
  await stop();
}
