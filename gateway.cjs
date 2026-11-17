// ═══════════════════════════════════════════════════════════════════════════
//  Jinx Harness — CGI gateway (runs as index.cgi via the shell wrapper)
//
//  One entry point for the whole app on shared hosting:
//   1. make sure the Node daemon is alive (boot it detached if not)
//   2. reverse-proxy this CGI request to it on 127.0.0.1:<port>
//
//  Apache executes index.cgi → this file runs under the account's own user
//  (suexec). The daemon is spawned with setsid (detached) so it survives the
//  CGI request; the bundle's single-instance lock prevents double boots.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'portable', 'data');
const LOGS = path.join(DATA, 'logs');

// ── port: must match app.js (port.txt → deterministic hash) ────────────────
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h >>> 0;
}
function computePort() { return 41000 + (fnv1a(String(process.env.HOME || ROOT)) % 2000); }
function readPort() {
  try {
    const p = parseInt(fs.readFileSync(path.join(DATA, 'port.txt'), 'utf8').trim(), 10);
    if (p > 1024 && p < 65536) return p;
  } catch { /* not booted yet */ }
  return computePort();
}
const PORT = readPort();

// ── public base path (e.g. /jinx-harness when installed in a subfolder) ──────
const SCRIPT_NAME = process.env.SCRIPT_NAME || '/index.cgi';
let BASE = path.posix.dirname(SCRIPT_NAME);
if (BASE === '/' || BASE === '.') BASE = '';

// ── CGI environment of this request ─────────────────────────────────────────
const METHOD = (process.env.REQUEST_METHOD || 'GET').toUpperCase();
const REQUEST_URI = process.env.REQUEST_URI || (SCRIPT_NAME + '/');
const CONTENT_LENGTH = parseInt(process.env.CONTENT_LENGTH || '0', 10) || 0;
const BOOT_BUDGET_MS = 30_000;

function log(line) {
  try {
    fs.mkdirSync(LOGS, { recursive: true });
    fs.appendFileSync(path.join(LOGS, 'gateway.log'), new Date().toISOString() + ' ' + line + '\n');
  } catch { /* best-effort */ }
}

function health(timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: (BASE || '') + '/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
      res.on('end', () => {
        try { resolve({ ok: res.statusCode === 200, status: res.statusCode, json: JSON.parse(body) }); }
        catch { resolve({ ok: res.statusCode === 200, status: res.statusCode, json: null }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, json: null }); });
    req.on('error', () => resolve({ ok: false, status: 0, json: null }));
  });
}

function bootDaemon() {
  return new Promise((resolve) => {
    try { fs.mkdirSync(LOGS, { recursive: true }); } catch {}
    const out = fs.openSync(path.join(LOGS, 'cgi-boot.log'), 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'app.js')], {
      cwd: ROOT,
      detached: true,               // setsid → survives CGI teardown
      stdio: ['ignore', out, out],
      env: {
        ...process.env,
        PORTABLE_PORT: String(PORT),
        PORTABLE_BASE_PATH: BASE,
        JINX_GATEWAY: '1',
      },
    });
    child.unref();
    log('boot: spawned pid=' + child.pid + ' port=' + PORT + ' base=' + (BASE || '/'));
    resolve();
  });
}

async function ensureDaemon() {
  let h = await health(1500);
  if (h.ok) return h;
  await bootDaemon();
  const deadline = Date.now() + BOOT_BUDGET_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    h = await health(1200);
    if (h.ok) return h;
  }
  return h; // still dead
}

function readSetupKey() {
  try { return fs.readFileSync(path.join(DATA, 'setup-key.txt'), 'utf8').trim() || null; } catch { return null; }
}

// ── CGI response helpers ────────────────────────────────────────────────────
function cgiOut(status, headers, body) {
  let head = 'Status: ' + status + '\r\n';
  for (const [k, v] of Object.entries(headers || {})) head += k + ': ' + v + '\r\n';
  process.stdout.write(head + '\r\n');
  process.stdout.write(body);
}
function html(status, body) {
  cgiOut(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body);
}

// ── proxy one request to the daemon ─────────────────────────────────────────
function proxy() {
  return new Promise((resolve) => {
    const headers = {};
    for (const k of ['content-type', 'authorization', 'cookie', 'user-agent', 'accept', 'accept-language', 'x-requested-with']) {
      const v = process.env['HTTP_' + k.toUpperCase().replace(/-/g, '_')];
      if (v) headers[k] = v;
    }
    const opts = {
      host: '127.0.0.1', port: PORT, method: METHOD,
      path: REQUEST_URI.startsWith('/') ? REQUEST_URI : '/' + REQUEST_URI,
      headers,
    };

    const send = (buf) => {
      const req = http.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const out = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (['transfer-encoding', 'connection', 'keep-alive', 'content-length'].includes(k)) continue;
            out[k] = v;
          }
          cgiOut(res.statusCode || 200, out, body);
          resolve();
        });
      });
      req.setTimeout(55_000, () => { req.destroy(); });
      req.on('error', (e) => {
        log('proxy error: ' + (e && e.message));
        html(502, errPage('The agent is not responding on port ' + PORT + '.<br>' +
          'Check <code>portable/data/logs/</code> — if the port is taken, set <code>PORTABLE_PORT</code> in <code>portable/.env</code> and retry.'));
        resolve();
      });
      if (buf && buf.length) req.write(buf);
      req.end();
    };

    if (CONTENT_LENGTH > 0) {
      const chunks = []; let n = 0;
      process.stdin.on('data', (c) => { n += c.length; if (n <= 16 * 1024 * 1024) chunks.push(c); });
      process.stdin.on('end', () => send(Buffer.concat(chunks)));
      process.stdin.on('error', () => send(Buffer.alloc(0)));
    } else {
      send(Buffer.alloc(0));
    }
  });
}

function errPage(msg) {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Jinx Harness</title><body style="background:#0b1020;color:#e8ecf8;font:15px/1.7 Vazirmatn,Tahoma,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">' +
    '<div style="max-width:520px;text-align:center"><div style="font-size:44px">⚠️</div><h3 style="margin:12px 0">Jinx Harness gateway</h3>' +
    '<p style="opacity:.75">' + msg + '</p></div></body>';
}

(async () => {
  try {
    // fast path: daemon already alive
    let h = await health(1200);
    if (!h.ok) h = await ensureDaemon();

    if (!h.ok) {
      html(502, errPage('Booting failed after ' + (BOOT_BUDGET_MS / 1000) + 's.<br>' +
        'Read the latest lines of <code>portable/data/logs/cgi-boot.log</code> in File Manager.'));
      return;
    }

    // first-run UX: while unconfigured, send visitors to the one-time wizard
    const mode = h.json && h.json.mode;
    if (mode === 'setup') {
      const u = new URL(REQUEST_URI, 'http://localhost');
      const p = u.pathname;
      const isRoot = p === (BASE || '/') || p === (BASE || '/') + '/' || p === SCRIPT_NAME;
      const isSetup = p === (BASE ? BASE + '/setup' : '/setup');
      if (!u.searchParams.get('k') && (isRoot || isSetup)) {
        const key = readSetupKey();
        res_redirect((BASE || '') + '/setup' + (key ? '?k=' + key : ''));
        return;
      }
    }

    await proxy();
  } catch (e) {
    log('fatal: ' + (e && e.stack || e));
    html(500, errPage('Gateway error: ' + String(e && e.message || e)));
  }
})();

function res_redirect(loc) {
  process.stdout.write('Status: 302\r\nLocation: ' + loc + '\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\n\r\nredirect ' + loc);
}
