import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const PINS = JSON.parse(fs.readFileSync('/ci/pins.json', 'utf8'));
const MAX_STREAM_BYTES = Number(PINS.evidence.max_file_bytes || 131072);
const MAX_TOTAL_BYTES = Number(PINS.evidence.max_total_bytes || 524288);
const JSON_RESERVE_BYTES = 65536;

const FORBIDDEN_ENV_KEYS = [
  'GEMINI_API_KEY',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_WEBHOOK_ID',
  'OPERATOR_TOKEN_SHA256',
  'GITHUB_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_RUNTIME_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_OPTIONS',
];

const EXPECTED_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'MODE',
  'PORT',
  'BASE',
  'BASE_URL',
  'DATA_DIR',
  'NODE_PATH',
  'PLAYWRIGHT_BROWSERS_PATH',
];

let totalCapturedLogBytes = 0;

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(65536);
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeEvidenceFile(name, buf) {
  const outPath = path.join('/evidence', name);
  fs.writeFileSync(outPath, buf);
  return {
    file: name,
    bytes: buf.length,
    sha256: sha256Buffer(buf),
  };
}

function probeExternalTcpFail(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    let settled = false;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ host, port, duration_ms: Date.now() - start, ...outcome });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done({ connected: true, error_code: null }));
    sock.once('timeout', () => done({ connected: false, error_code: 'ETIMEDOUT' }));
    sock.once('error', (err) => done({ connected: false, error_code: err.code || String(err) }));
    try {
      sock.connect(port, host);
    } catch (err) {
      done({ connected: false, error_code: err.code || String(err) });
    }
  });
}

function killProcessGroup(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch (_) {
    try {
      process.kill(pid, sig);
    } catch (_) {}
  }
}

function runSubprocess(label, cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (spawnSyncErr) {
      const emptyBuf = Buffer.alloc(0);
      const outMeta = writeEvidenceFile(`${label}.stdout.log`, emptyBuf);
      const errMeta = writeEvidenceFile(`${label}.stderr.log`, emptyBuf);
      resolve({
        label,
        not_started: true,
        spawn_error: String(spawnSyncErr && spawnSyncErr.message ? spawnSyncErr.message : spawnSyncErr),
        exit_code: null,
        signal: null,
        timed_out: false,
        truncated: false,
        duration_ms: Date.now() - t0,
        stdout: '',
        stderr: '',
        stdout_meta: outMeta,
        stderr_meta: errMeta,
      });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let killTimer = null;
    let spawnErrStr = null;
    let settled = false;

    child.on('error', (err) => {
      spawnErrStr = String(err && err.message ? err.message : err);
    });

    const mainTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => killProcessGroup(child.pid, 'SIGKILL'), 3000);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes + chunk.length > MAX_STREAM_BYTES || totalCapturedLogBytes + chunk.length > MAX_TOTAL_BYTES - JSON_RESERVE_BYTES) {
        truncated = true;
        killProcessGroup(child.pid, 'SIGTERM');
        return;
      }
      stdoutBytes += chunk.length;
      totalCapturedLogBytes += chunk.length;
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBytes + chunk.length > MAX_STREAM_BYTES || totalCapturedLogBytes + chunk.length > MAX_TOTAL_BYTES - JSON_RESERVE_BYTES) {
        truncated = true;
        killProcessGroup(child.pid, 'SIGTERM');
        return;
      }
      stderrBytes += chunk.length;
      totalCapturedLogBytes += chunk.length;
      stderrChunks.push(chunk);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(mainTimer);
      if (killTimer) clearTimeout(killTimer);
      killProcessGroup(child.pid, 'SIGKILL');
      const outBuf = Buffer.concat(stdoutChunks);
      const errBuf = Buffer.concat(stderrChunks);
      const outMeta = writeEvidenceFile(`${label}.stdout.log`, outBuf);
      const errMeta = writeEvidenceFile(`${label}.stderr.log`, errBuf);
      resolve({
        label,
        not_started: spawnErrStr !== null && code === null && signal === null,
        spawn_error: spawnErrStr,
        exit_code: typeof code === 'number' ? code : null,
        signal: signal || null,
        timed_out: timedOut,
        truncated,
        duration_ms: Date.now() - t0,
        stdout: outBuf.toString('utf8'),
        stderr: errBuf.toString('utf8'),
        stdout_meta: outMeta,
        stderr_meta: errMeta,
      });
    });
  });
}

function waitHttpReady(url, deadlineMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() - start > deadlineMs) {
        reject(new Error(`Server readiness timeout after ${deadlineMs}ms`));
        return;
      }
      const req = http.get(url, { timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve({ status_code: res.statusCode, ready_ms: Date.now() - start });
        } else {
          setTimeout(attempt, 100);
        }
      });
      req.on('error', () => setTimeout(attempt, 100));
      req.on('timeout', () => {
        req.destroy();
        setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function parseTapOutput(tapText) {
  const lines = tapText.split(/\r?\n/);
  let planStart = null;
  let planEnd = null;
  let topTotal = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let todo = 0;
  let cancelled = 0;

  for (const line of lines) {
    const planMatch = /^1\.\.(\d+)\s*$/.exec(line);
    if (planMatch) {
      planStart = 1;
      planEnd = Number(planMatch[1]);
      continue;
    }
    const testMatch = /^(ok|not ok)\s+(\d+)\b(.*)$/.exec(line);
    if (testMatch) {
      topTotal += 1;
      const status = testMatch[1];
      const rest = testMatch[3] || '';
      const dirMatch = /#\s*(SKIP|TODO|CANCELLED)\b/i.exec(rest);
      const directive = dirMatch ? dirMatch[1].toUpperCase() : null;
      if (directive === 'CANCELLED' || /cancelled/i.test(rest)) {
        cancelled += 1;
      } else if (directive === 'SKIP') {
        skipped += 1;
      } else if (directive === 'TODO') {
        todo += 1;
      } else if (status === 'ok') {
        passed += 1;
      } else {
        failed += 1;
      }
    }
  }

  const summaryMetric = (regex) => {
    const m = regex.exec(tapText);
    return m ? Number(m[1]) : null;
  };

  const diagTests = summaryMetric(/^# tests\s+(\d+)/m);
  const diagPass = summaryMetric(/^# pass\s+(\d+)/m);
  const diagFail = summaryMetric(/^# fail\s+(\d+)/m);
  const diagCancelled = summaryMetric(/^# cancelled\s+(\d+)/m);
  const diagSkipped = summaryMetric(/^# skipped\s+(\d+)/m);
  const diagTodo = summaryMetric(/^# todo\s+(\d+)/m);

  const footerFields = [diagTests, diagPass, diagFail, diagCancelled, diagSkipped, diagTodo];
  const footerAllPresent = footerFields.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0);
  const footerSumConsistent = footerAllPresent && (diagPass + diagFail + diagCancelled + diagSkipped + diagTodo === diagTests);
  const planConsistent = (
    planStart === 1 &&
    typeof planEnd === 'number' &&
    Number.isInteger(planEnd) &&
    planEnd > 0 &&
    topTotal === planEnd &&
    (passed + failed + cancelled + skipped + todo === topTotal)
  );
  const footerValid = Boolean(footerAllPresent && footerSumConsistent && planConsistent && diagTests > 0);

  return {
    plan_start: planStart,
    plan_end: planEnd,
    plan_consistent: planConsistent,
    footer_all_present: footerAllPresent,
    footer_sum_consistent: footerSumConsistent,
    footer_valid: footerValid,
    top_level: { total: topTotal, passed, failed, cancelled, skipped, todo },
    diagnostic_totals: {
      total: diagTests,
      passed: diagPass,
      failed: diagFail,
      cancelled: diagCancelled,
      skipped: diagSkipped,
      todo: diagTodo,
    },
  };
}

async function runE2eWithFreshServer(label, scriptRelPath, dataDirPath, stageBudgetSec) {
  const stageStart = Date.now();
  const totalBudgetMs = stageBudgetSec * 1000;
  fs.mkdirSync(dataDirPath, { recursive: true });

  const port = Number(PINS.runtime.port || 8799);
  const baseUrl = `http://localhost:${port}`;
  const serverEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG || 'C.UTF-8',
    MODE: 'fixture',
    PORT: String(port),
    BASE: baseUrl,
    BASE_URL: baseUrl,
    DATA_DIR: dataDirPath,
    NODE_PATH: process.env.NODE_PATH,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
  };

  let srvChild = null;
  let srvSpawnError = null;
  try {
    srvChild = spawn(process.execPath, ['src/servidor.mjs'], {
      cwd: '/product',
      env: serverEnv,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    srvSpawnError = String(err && err.message ? err.message : err);
  }

  if (srvChild) {
    srvChild.on('error', (err) => {
      srvSpawnError = String(err && err.message ? err.message : err);
    });
  }

  const srvOutChunks = [];
  const srvErrChunks = [];
  let srvOutBytes = 0;
  let srvErrBytes = 0;
  let srvTruncated = false;

  if (srvChild && srvChild.stdout) {
    srvChild.stdout.on('data', (c) => {
      if (srvOutBytes + c.length > MAX_STREAM_BYTES || totalCapturedLogBytes + c.length > MAX_TOTAL_BYTES - JSON_RESERVE_BYTES) {
        srvTruncated = true;
        return;
      }
      srvOutBytes += c.length;
      totalCapturedLogBytes += c.length;
      srvOutChunks.push(c);
    });
  }
  if (srvChild && srvChild.stderr) {
    srvChild.stderr.on('data', (c) => {
      if (srvErrBytes + c.length > MAX_STREAM_BYTES || totalCapturedLogBytes + c.length > MAX_TOTAL_BYTES - JSON_RESERVE_BYTES) {
        srvTruncated = true;
        return;
      }
      srvErrBytes += c.length;
      totalCapturedLogBytes += c.length;
      srvErrChunks.push(c);
    });
  }

  let srvExitCode = null;
  let srvSignal = null;
  let srvClosed = !srvChild;
  const srvClosedPromise = new Promise((res) => {
    if (!srvChild) {
      res();
      return;
    }
    srvChild.on('close', (code, sig) => {
      srvClosed = true;
      srvExitCode = typeof code === 'number' ? code : null;
      srvSignal = sig || null;
      res();
    });
  });

  let readiness = null;
  let readinessError = null;
  let testResult = null;
  try {
    if (srvSpawnError || !srvChild) {
      throw new Error(`Fixture server spawn failed: ${srvSpawnError || 'no child'}`);
    }
    readiness = await waitHttpReady(`${baseUrl}/`, 10000);
    if (srvClosed || srvExitCode !== null || srvSignal !== null) {
      throw new Error(`Fixture server exited prematurely with code ${srvExitCode}`);
    }
    const elapsed = Date.now() - stageStart;
    const remainingForTestMs = Math.max(5000, totalBudgetMs - elapsed - 5000);
    testResult = await runSubprocess(
      label,
      process.execPath,
      [scriptRelPath],
      { cwd: '/product', env: serverEnv, timeoutMs: remainingForTestMs }
    );
  } catch (err) {
    readinessError = String(err && err.message ? err.message : err);
  } finally {
    if (srvChild && !srvClosed) {
      killProcessGroup(srvChild.pid, 'SIGTERM');
      const stopTimer = setTimeout(() => killProcessGroup(srvChild.pid, 'SIGKILL'), 4000);
      await srvClosedPromise;
      clearTimeout(stopTimer);
    }
  }

  if (!testResult) {
    const emptyBuf = Buffer.alloc(0);
    const outMeta = writeEvidenceFile(`${label}.stdout.log`, emptyBuf);
    const errMeta = writeEvidenceFile(`${label}.stderr.log`, emptyBuf);
    testResult = {
      label,
      not_started: true,
      spawn_error: readinessError,
      exit_code: null,
      signal: null,
      timed_out: false,
      truncated: false,
      duration_ms: 0,
      stdout: '',
      stderr: '',
      stdout_meta: outMeta,
      stderr_meta: errMeta,
    };
  }

  const srvOutBuf = Buffer.concat(srvOutChunks);
  const srvErrBuf = Buffer.concat(srvErrChunks);
  const srvOutMeta = writeEvidenceFile(`${label}-server.stdout.log`, srvOutBuf);
  const srvErrMeta = writeEvidenceFile(`${label}-server.stderr.log`, srvErrBuf);

  return {
    label,
    script: scriptRelPath,
    data_dir: dataDirPath,
    duration_ms: Date.now() - stageStart,
    readiness,
    readiness_error: readinessError,
    server: {
      spawn_error: srvSpawnError,
      exit_code: srvExitCode,
      signal: srvSignal,
      clean_sigterm_exit_0: srvSpawnError === null && srvExitCode === 0 && srvSignal === null,
      truncated: srvTruncated,
      stdout_meta: srvOutMeta,
      stderr_meta: srvErrMeta,
    },
    test: testResult,
  };
}

(async () => {
  const summary = {
    schema: 'catalog-gate-inside-summary-v1',
    started_at_utc: new Date().toISOString(),
    ok: false,
    failure_reason: null,
    note_simulation: 'Fixture mode only. Node/capture financial counters are simulated offline; NOT real PayPal Sandbox or live money.',
    external_url_requests_count: 'NOT_MEASURED_NO_URL_OBSERVER_IN_V1_GUARANTEED_BY_KERNEL_NETWORK_NONE_AND_ZERO_CONSOLE_ERRORS',
    toolchain: {},
    isolation: {},
    unit: null,
    e2e_c3a: null,
    e2e_u1: null,
  };

  try {
    fs.mkdirSync('/tmp/cg-home', { recursive: true });
    fs.mkdirSync('/tmp/cg-tmp', { recursive: true });

    // 1. Validate Node >= 22 and clean environment
    const nodeVer = process.versions.node;
    const major = Number(nodeVer.split('.')[0]);
    if (!Number.isInteger(major) || major < 22) {
      throw new Error(`Node version >=22 required, observed ${nodeVer}`);
    }

    const presentForbidden = FORBIDDEN_ENV_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(process.env, k) && process.env[k] !== '');
    if (presentForbidden.length > 0) {
      throw new Error(`Forbidden env vars present: ${presentForbidden.join(', ')}`);
    }

    const unexpectedEnv = Object.keys(process.env).filter((k) => !EXPECTED_ENV_KEYS.includes(k));
    if (unexpectedEnv.length > 0) {
      throw new Error(`Unexpected non-allowlisted env vars: ${unexpectedEnv.join(', ')}`);
    }

    // 2. Resolve CJS playwright & playwright-core and verify Chromium
    const pwPkgJson = require('playwright/package.json');
    const pwCorePkgJson = require('playwright-core/package.json');
    if (pwPkgJson.version !== PINS.toolchain.playwright_version || pwCorePkgJson.version !== PINS.toolchain.playwright_version) {
      throw new Error(`Playwright version mismatch: playwright=${pwPkgJson.version}, core=${pwCorePkgJson.version}`);
    }

    const { chromium } = require('playwright');
    const configuredBrowserExecutable = chromium.executablePath();
    const configuredBrowserSha256 = sha256File(configuredBrowserExecutable);
    const probeBrowser = await chromium.launch();
    const observedBrowserVersion = probeBrowser.version();
    await probeBrowser.close();

    summary.toolchain = {
      node_version: nodeVer,
      node_exec_path: process.execPath,
      node_exec_sha256: sha256File(process.execPath),
      playwright_version: pwPkgJson.version,
      playwright_core_version: pwCorePkgJson.version,
      configured_chromium_executable_path: configuredBrowserExecutable,
      configured_chromium_executable_sha256: configuredBrowserSha256,
      observed_browser_version_from_probe: observedBrowserVersion,
      e2e_child_browser_pid_note: 'E2E scripts launch their own Chromium subprocess; executable path/SHA256 is verified from configured toolchain above, not claimed by PID introspection during E2E runs.',
    };

    // 3. Stage 3: Isolation verification (loopback only + failed external numeric TCP probe)
    const isoStart = Date.now();
    const ifaces = os.networkInterfaces();
    const ifaceNames = Object.keys(ifaces);
    const nonLoopbackIfaces = [];
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const a of addrs || []) {
        if (!a.internal) {
          nonLoopbackIfaces.push({ name, address: a.address, family: a.family });
        }
      }
    }
    const netDevRaw = fs.existsSync('/proc/net/dev') ? fs.readFileSync('/proc/net/dev', 'utf8') : '';
    const netRouteRaw = fs.existsSync('/proc/net/route') ? fs.readFileSync('/proc/net/route', 'utf8') : '';
    const tcpProbe1 = await probeExternalTcpFail('1.1.1.1', 443, 2500);
    const tcpProbe2 = await probeExternalTcpFail('8.8.8.8', 53, 2500);

    summary.isolation = {
      duration_ms: Date.now() - isoStart,
      interface_names: ifaceNames,
      non_loopback_addresses: nonLoopbackIfaces,
      proc_net_dev: netDevRaw,
      proc_net_route: netRouteRaw,
      external_tcp_probes: [tcpProbe1, tcpProbe2],
      env_keys_observed: Object.keys(process.env).sort(),
    };

    if (nonLoopbackIfaces.length > 0) {
      throw new Error(`Non-loopback network interfaces detected: ${JSON.stringify(nonLoopbackIfaces)}`);
    }
    if (tcpProbe1.connected || tcpProbe2.connected) {
      throw new Error('External TCP probe unexpectedly succeeded under --network none');
    }

    // 4. Stage 4: Unit tests (11 files in test/*.test.mjs)
    const unitFiles = fs.readdirSync('/product/test')
      .filter((f) => f.endsWith('.test.mjs'))
      .sort()
      .map((f) => path.posix.join('test', f));

    if (unitFiles.length !== 11) {
      throw new Error(`Expected exactly 11 unit test files, discovered ${unitFiles.length}`);
    }

    const unitEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG || 'C.UTF-8',
    };

    const unitRun = await runSubprocess(
      'unit-tap',
      process.execPath,
      ['--test', '--test-reporter=tap', ...unitFiles],
      { cwd: '/product', env: unitEnv, timeoutMs: Number(PINS.budgets.unit_seconds) * 1000 }
    );
    const tapParsed = parseTapOutput(unitRun.stdout);
    const dt = tapParsed.diagnostic_totals;
    const tl = tapParsed.top_level;
    const unitOk = (
      !unitRun.not_started &&
      unitRun.spawn_error === null &&
      unitRun.exit_code === 0 &&
      unitRun.signal === null &&
      !unitRun.timed_out &&
      !unitRun.truncated &&
      tapParsed.footer_valid === true &&
      tl.passed > 0 &&
      tl.failed === 0 &&
      tl.cancelled === 0 &&
      tl.skipped === 0 &&
      tl.todo === 0 &&
      dt.passed > 0 &&
      dt.failed === 0 &&
      dt.cancelled === 0 &&
      dt.skipped === 0 &&
      dt.todo === 0
    );

    summary.unit = {
      ok: unitOk,
      discovered_files_count: unitFiles.length,
      discovered_files: unitFiles,
      env_keys_passed: Object.keys(unitEnv).sort(),
      not_started: unitRun.not_started,
      spawn_error: unitRun.spawn_error,
      exit_code: unitRun.exit_code,
      signal: unitRun.signal,
      timed_out: unitRun.timed_out,
      truncated: unitRun.truncated,
      duration_ms: unitRun.duration_ms,
      tap_counts: tapParsed,
      stdout_meta: unitRun.stdout_meta,
      stderr_meta: unitRun.stderr_meta,
    };
    if (!unitOk) {
      throw new Error(`Unit suite failed (rc=${unitRun.exit_code}, counts=${JSON.stringify(dt)})`);
    }

    // 5. Stage 5: E2E 1 - c3a-pedido-vinculo.e2e.cjs
    const c3aScript = 'test/e2e/c3a-pedido-vinculo.e2e.cjs';
    if (!PINS.product.files.some((f) => f.path === c3aScript)) {
      throw new Error(`Pinned file missing: ${c3aScript}`);
    }
    const c3aRun = await runE2eWithFreshServer(
      'e2e-c3a',
      c3aScript,
      '/tmp/cg-data-c3a',
      Number(PINS.budgets.e2e_C3a_seconds)
    );
    summary.e2e_c3a = {
      ok: false,
      not_started: c3aRun.test.not_started,
      spawn_error: c3aRun.test.spawn_error,
      exit_code: c3aRun.test.exit_code,
      signal: c3aRun.test.signal,
      timed_out: c3aRun.test.timed_out,
      truncated: c3aRun.test.truncated,
      duration_ms: c3aRun.duration_ms,
      readiness: c3aRun.readiness,
      readiness_error: c3aRun.readiness_error,
      server: c3aRun.server,
      parsed_json: null,
      parse_error: null,
      stdout_meta: c3aRun.test.stdout_meta,
      stderr_meta: c3aRun.test.stderr_meta,
    };
    let c3aJson = null;
    let c3aParseError = null;
    const c3aTrimmed = c3aRun.test.stdout.trim();
    if (!c3aTrimmed) {
      c3aParseError = 'Empty stdout from c3a E2E script';
    } else {
      try {
        const lastLine = c3aTrimmed.split(/\r?\n/).pop();
        c3aJson = JSON.parse(lastLine);
      } catch (pErr) {
        c3aParseError = String(pErr && pErr.message ? pErr.message : pErr);
      }
    }
    const c3aOk = Boolean(
      !c3aRun.test.not_started &&
      c3aRun.test.spawn_error === null &&
      c3aRun.readiness_error === null &&
      c3aRun.test.exit_code === 0 &&
      c3aRun.test.signal === null &&
      !c3aRun.test.timed_out &&
      !c3aRun.test.truncated &&
      c3aRun.server.clean_sigterm_exit_0 &&
      !c3aRun.server.truncated &&
      c3aParseError === null &&
      c3aJson &&
      c3aJson.ok === true &&
      Array.isArray(c3aJson.falhas) &&
      c3aJson.falhas.length === 0
    );
    summary.e2e_c3a.ok = c3aOk;
    summary.e2e_c3a.parsed_json = c3aJson;
    summary.e2e_c3a.parse_error = c3aParseError;
    if (!c3aOk) {
      throw new Error(`E2E C3a failed (rc=${c3aRun.test.exit_code}, server_clean=${c3aRun.server.clean_sigterm_exit_0})`);
    }

    // 6. Stage 6: E2E 2 - c3au1-respostas-atrasadas.e2e.cjs
    const u1Script = 'test/e2e/c3au1-respostas-atrasadas.e2e.cjs';
    if (!PINS.product.files.some((f) => f.path === u1Script)) {
      throw new Error(`Pinned file missing: ${u1Script}`);
    }
    const u1Run = await runE2eWithFreshServer(
      'e2e-u1',
      u1Script,
      '/tmp/cg-data-u1',
      Number(PINS.budgets.e2e_U1_seconds)
    );
    summary.e2e_u1 = {
      ok: false,
      not_started: u1Run.test.not_started,
      spawn_error: u1Run.test.spawn_error,
      exit_code: u1Run.test.exit_code,
      signal: u1Run.test.signal,
      timed_out: u1Run.test.timed_out,
      truncated: u1Run.test.truncated,
      duration_ms: u1Run.duration_ms,
      readiness: u1Run.readiness,
      readiness_error: u1Run.readiness_error,
      server: u1Run.server,
      parsed_json: null,
      parse_error: null,
      stdout_meta: u1Run.test.stdout_meta,
      stderr_meta: u1Run.test.stderr_meta,
    };
    let u1Json = null;
    let u1ParseError = null;
    const u1Trimmed = u1Run.test.stdout.trim();
    if (!u1Trimmed) {
      u1ParseError = 'Empty stdout from u1 E2E script';
    } else {
      try {
        u1Json = JSON.parse(u1Trimmed);
      } catch (pErr) {
        u1ParseError = String(pErr && pErr.message ? pErr.message : pErr);
      }
    }
    const expectedScenarios = ['U1-01', 'U1-02', 'U1-03', 'U1-04', 'U1-05', 'U1-06', 'U1-07'];
    const observedScenarios = u1Json && u1Json.resultado ? Object.keys(u1Json.resultado) : [];
    const exactSevenMatch = (
      u1ParseError === null &&
      observedScenarios.length === expectedScenarios.length &&
      expectedScenarios.every((k, idx) => observedScenarios[idx] === k) &&
      expectedScenarios.every((k) => {
        const r = u1Json.resultado[k];
        return r && r.ok === true && Array.isArray(r.falhas) && r.falhas.length === 0 && Array.isArray(r.posts);
      })
    );
    const u1Ok = Boolean(
      !u1Run.test.not_started &&
      u1Run.test.spawn_error === null &&
      u1Run.readiness_error === null &&
      u1Run.test.exit_code === 0 &&
      u1Run.test.signal === null &&
      !u1Run.test.timed_out &&
      !u1Run.test.truncated &&
      u1Run.server.clean_sigterm_exit_0 &&
      !u1Run.server.truncated &&
      u1ParseError === null &&
      u1Json &&
      u1Json.ok === true &&
      exactSevenMatch
    );
    summary.e2e_u1.ok = u1Ok;
    summary.e2e_u1.parsed_json = u1Json;
    summary.e2e_u1.parse_error = u1ParseError;
    if (!u1Ok) {
      throw new Error(`E2E U1 failed (rc=${u1Run.test.exit_code}, exactSevenMatch=${exactSevenMatch})`);
    }

    summary.ok = true;
    summary.finished_at_utc = new Date().toISOString();
    fs.writeFileSync('/evidence/inside-summary.json', JSON.stringify(summary, null, 2));
    process.exit(0);
  } catch (err) {
    summary.ok = false;
    summary.failure_reason = String(err && err.stack ? err.stack : err);
    summary.finished_at_utc = new Date().toISOString();
    try {
      fs.writeFileSync('/evidence/inside-summary.json', JSON.stringify(summary, null, 2));
    } catch (_) {}
    process.exit(1);
  }
})();
