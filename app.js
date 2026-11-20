#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  Jinx Harness v9.3 (open-source) — startup file
//
//  Works in three environments, no build step, no npm install required:
//   • cPanel "Setup Node.js App" (Passenger) — pick this file as startup
//   • Shared hosting without Passenger — booted by index.cgi (gateway.cjs)
//   • VPS / local — `node app.js`
//
//  First run without configuration → a web setup wizard starts (open the
//  app URL). After portable/.env exists → the full agent boots.
//
//  Env knobs (portable/.env or real environment — see README.md):
//   BOT_TOKEN, ADMIN_ID, JINX_API_KEY, JINX_BASE_URL, JINX_MODEL,
//   JINX_BRAND_NAME, JINX_MAKER_NAME, JINX_PERSONA, JINX_ALIAS,
//   WEBHOOK_SECRET, TIMEZONE, DEFAULT_LANG, PORTABLE_PORT, PORTABLE_BASE_PATH,
//   JINX_MCP_SERVERS, JINX_MCP_TIMEOUT_MS        (MCP client — docs/MCP.md)
//   JINX_PUBLIC_URL                               (public CGI base — MCP OAuth)
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const path = require('node:path');
const fs = require('node:fs');

// Passenger/cron may start us from any cwd — always work from package root
process.chdir(__dirname);

// Passenger exposes its port as PORT; normalize to PORTABLE_PORT
if (process.env.PORT && !process.env.PORTABLE_PORT) {
  process.env.PORTABLE_PORT = process.env.PORT;
}

// ── port resolution (identical algorithm in gateway.cjs) ───────────────────
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function computePort() {
  return 41000 + (fnv1a(String(process.env.HOME || process.cwd())) % 2000);
}
function resolvePort() {
  if (process.env.PORTABLE_PORT) {
    const p = Number(process.env.PORTABLE_PORT);
    if (p > 1024 && p < 65536) return p;
  }
  try {
    const p = parseInt(fs.readFileSync(path.join(__dirname, 'portable', 'data', 'port.txt'), 'utf8').trim(), 10);
    if (p > 1024 && p < 65536) return p;
  } catch { /* no port file yet */ }
  return computePort();
}
const PORT = resolvePort();
try {
  fs.mkdirSync(path.join(__dirname, 'portable', 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'portable', 'data', 'port.txt'), String(PORT) + '\n');
} catch { /* best-effort */ }

// ── load portable/.env into process.env (real environment wins) ────────────
const ENV_FILE = path.join(__dirname, 'portable', '.env');
function parseEnvFile(p) {
  const out = {};
  try {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[k] = v;
    }
  } catch { /* missing file */ }
  return out;
}
for (const [k, v] of Object.entries(parseEnvFile(ENV_FILE))) {
  if (!(k in process.env)) process.env[k] = v;
}

// ── self-test: node app.js --check ─────────────────────────────────────────
if (process.argv.includes('--check')) {
  require(path.join(__dirname, 'check.js'));
  return;
}

// ── deploy probe (only trace of boot on cron-driven hosts) ─────────────────
try {
  fs.appendFileSync(
    path.join(__dirname, 'portable', 'data', 'boot.txt'),
    new Date().toISOString() + ' node=' + process.version + ' platform=' + process.platform +
    ' rss0=' + Math.round(process.memoryUsage().rss / 1048576) + 'MB\n'
  );
} catch { /* best-effort */ }

// ── mode selection ─────────────────────────────────────────────────────────
const cfg = parseEnvFile(ENV_FILE);
const tok = process.env.BOT_TOKEN || cfg.BOT_TOKEN;
const key = process.env.JINX_API_KEY || cfg.JINX_API_KEY;
const baseUrl = process.env.JINX_BASE_URL || cfg.JINX_BASE_URL;
const model = process.env.JINX_MODEL || cfg.JINX_MODEL;
const configured = !!(tok && key && baseUrl && model);

if (!configured) {
  // ── SETUP MODE: web wizard only, no Telegram, no agent ───────────────────
  console.log('[jinx-harness] no configuration found — setup wizard starting on port ' + PORT);
  const setup = require('./setup-server.cjs');
  setup.start({
    port: PORT,
    root: __dirname,
    // In CGI mode the gateway holds a per-install key so neighbours on a
    // shared host cannot configure your bot. Passenger is isolated anyway.
    setupKey: process.env.JINX_GATEWAY === '1',
  });
  return;
}

// ── FULL BOOT ──────────────────────────────────────────────────────────────
console.log('[jinx-harness] v2.1.0 (engine 9.3.1-oss + MCP bridge & OAuth) booting — Node ' + process.version);
console.log('[jinx-harness] database: portable/data/jinx.db • panel: /admin?t=… • logs: portable/data/logs/');
console.log('[jinx-harness] MCP: JINX_MCP_SERVERS / portable/mcp.json — or just tell the agent to connect a server (mcp_connect, owner-approved) • docs/MCP.md');

// Shared hosts with a low RLIMIT_AS cannot reserve WebAssembly memory, which
// breaks Node's internal HTTP engine (undici/llhttp-wasm) on every fetch().
// On such hosts a pure-JS fetch shim is installed over node:https (same API:
// SSE streams, file upload, redirects, gzip, AbortSignal). Healthy hosts
// keep the native fetch untouched.
try {
  const shim = require('./fetch-shim.cjs');
  if (shim.wasmBroken() || process.env.JINX_FORCE_FETCH_SHIM === '1') {
    globalThis.fetch = shim.fetch;
    console.log('[jinx-harness] pure-JS fetch shim installed ✓' + (shim.wasmBroken() ? ' (virtual memory cap — WASM unavailable)' : ' (JINX_FORCE_FETCH_SHIM=1)'));
    // Node 22: creating ANY Request/Response object lazily initializes
    // llhttp-WASM inside undici; on capped hosts that init OOMs once and
    // screams as an unhandled rejection. Native fetch is never used here, so
    // defuse that init into a never-settling promise: no reject, no waiters,
    // clean logs.
    try {
      const _instantiate = WebAssembly.instantiate;
      const isWasmOOM = (e) => /Wasm memory|Out of memory/i.test(String((e && e.message) || e));
      let defused = false;
      WebAssembly.instantiate = function (...a) {
        let p;
        try { p = _instantiate.apply(this, a); }
        catch (e) {
          if (isWasmOOM(e)) {
            if (!defused) { defused = true; console.log('[jinx-harness] llhttp-WASM unsupported on this host (expected) — native fetch off, shim active ✓'); }
            return new Promise(() => {});
          }
          throw e;
        }
        if (p && typeof p.catch === 'function') {
          return p.then(undefined, (e) => {
            if (isWasmOOM(e)) {
              if (!defused) { defused = true; console.log('[jinx-harness] llhttp-WASM unsupported on this host (expected) — native fetch off, shim active ✓'); }
              return new Promise(() => {});
            }
            throw e;
          });
        }
        return p;
      };
    } catch { /* best-effort */ }
  }
} catch (e) {
  console.warn('[jinx-harness] fetch-shim not loaded:', e && e.message);
}

require('./dist/portable.cjs');
