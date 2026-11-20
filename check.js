#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  Jinx Harness — pre-flight self-test     (run:  node app.js --check)
//
//  Checks the whole chain before you rely on it: files, config, database,
//  write permissions, Telegram connection, AI provider connection, disk.
//  Read-only — changes nothing.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const results = [];
let failed = 0;

function ok(name, detail) { results.push(['✓', name, detail || '']); }
function bad(name, detail) { results.push(['✗', name, detail || '']); failed++; }
function warn(name, detail) { results.push(['⚠', name, detail || '']); }
function ok_or(cond, name, detail) { cond ? ok(name, detail) : bad(name, detail); }

function fmtB(n) {
  n = Number(n) || 0;
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function envMap() {
  const out = { ...process.env };
  try {
    for (const line of fs.readFileSync(path.join(ROOT, 'portable', '.env'), 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in out) || !out[k]) out[k] = v;
    }
  } catch { /* no .env yet */ }
  return out;
}

async function main() {
  const env = envMap();
  console.log('\n🩺 Jinx Harness v2.1.0 — pre-flight self-test\n' + '─'.repeat(52));

  // 1. Node
  const v = process.versions.node;
  const major = Number(v.split('.')[0]);
  if (major >= 22) ok('Node version', `v${v} (great — built-in node:sqlite)`);
  else if (major >= 18) warn('Node version', `v${v} works, 22+ recommended (needs sql.js fallback: npm install sql.js)`);
  else bad('Node version', `v${v} is too old — 18+ required`);

  // 2. Package files
  ok_or(fs.existsSync(path.join(ROOT, 'dist', 'portable.cjs')), 'Agent bundle (dist/portable.cjs)',
    fs.existsSync(path.join(ROOT, 'dist', 'portable.cjs')) ? fmtB(fs.statSync(path.join(ROOT, 'dist', 'portable.cjs')).size) : 'missing — incomplete upload');
  const mcpOk = fs.existsSync(path.join(ROOT, 'mcp-bridge.cjs'));
  const oauthOk = fs.existsSync(path.join(ROOT, 'mcp-oauth.cjs'));
  if (mcpOk && oauthOk) ok('MCP bridge (mcp-bridge.cjs + mcp-oauth.cjs)', 'v2.1 client — plain / API-key / OAuth servers + agent self-connect');
  else if (mcpOk) warn('MCP bridge (mcp-bridge.cjs)', 'mcp-oauth.cjs missing — login-required (OAuth) MCP servers unavailable');
  else warn('MCP bridge (mcp-bridge.cjs)', 'missing — agent runs without MCP tools (v1 layout?)');
  const v21 = fs.existsSync(path.join(ROOT, 'dist', 'portable.cjs')) &&
    fs.readFileSync(path.join(ROOT, 'dist', 'portable.cjs'), 'utf8').includes('repairToolHistory');
  if (v21) ok('Engine v2.1 patches', 'tool-history 400 fix + OAuth route + permission hook');
  else warn('Engine v2.1 patches', 'dist/portable.cjs looks pre-2.1 — re-upload the bundle');
  try {
    const patched = fs.readFileSync(path.join(ROOT, 'dist', 'portable.cjs'), 'utf8').includes('mcp-bridge.cjs');
    ok_or(patched, 'MCP bridge wired into engine', patched ? '' : 'bundle is pre-v2 — re-upload dist/portable.cjs');
  } catch { /* bundle already reported */ }
  const wasm = fs.existsSync(path.join(ROOT, 'dist')) &&
    fs.readdirSync(path.join(ROOT, 'dist')).find((f) => /^quickjs.*\.wasm$/.test(f));
  if (wasm) ok('QuickJS/WASM engine (run_js)', wasm);
  else warn('QuickJS/WASM engine', 'not shipped — run_js falls back to the built-in interpreter');
  ok_or(fs.existsSync(path.join(ROOT, 'portable', '.env')), 'Configuration (portable/.env)',
    'missing → open /setup in your browser to create it');

  // 3. Secrets (only if .env exists)
  const tok = env.BOT_TOKEN || '';
  const key = env.JINX_API_KEY || '';
  const base = String(env.JINX_BASE_URL || '').replace(/\/+$/, '');
  const model = env.JINX_MODEL || '';
  if (tok || key) {
    ok_or(/^\d+:[\w-]{20,}$/.test(tok), 'Telegram bot token', tok ? '…' + tok.slice(-6) : 'missing');
    ok_or(key.length >= 8, 'AI API key', key ? '…' + key.slice(-4) : 'missing');
    ok_or(/^https?:\/\//.test(base), 'AI base URL', base || 'missing');
    ok_or(!!model, 'AI model', model || 'missing');
    ok_or(!!(env.WEBHOOK_SECRET && env.WEBHOOK_SECRET.length >= 16), 'Panel secret (WEBHOOK_SECRET)', 'needed for /admin');
  }

  // 4. Write permission
  const dataDir = path.join(ROOT, 'portable', 'data');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    ok('Write permission (portable/data)', '');
  } catch (e) {
    bad('Write permission (portable/data)', String(e.message || e));
  }

  // 5. Database
  const dbPath = env.JINX_PORTABLE_DB || path.join(dataDir, 'jinx.db');
  if (fs.existsSync(dbPath)) {
    let counts = '';
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const u = db.prepare('SELECT COUNT(*) c FROM users').get().c;
      const m = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
      const p = db.prepare('SELECT COUNT(*) c FROM ws_projects').get().c;
      db.close();
      counts = ` — ${u} users, ${m} messages, ${p} projects`;
      ok('Database (node:sqlite)', fmtB(fs.statSync(dbPath).size) + counts);
    } catch {
      warn('Database', fmtB(fs.statSync(dbPath).size) + ' — not openable with this Node (agent will try sql.js)');
    }
  } else {
    warn('Database', 'jinx.db not created yet — appears on first full boot');
  }

  // 6. Telegram connectivity
  if (tok) {
    const tgBase = String(env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
    try {
      const t0 = Date.now();
      const res = await fetch(`${tgBase}/bot${tok}/getMe`, { signal: AbortSignal.timeout(10_000) });
      const j = await res.json().catch(() => ({}));
      if (j && j.ok) ok('Telegram connection', `@${(j.result || {}).username} • ${Date.now() - t0}ms`);
      else bad('Telegram connection', (j && j.description) || `HTTP ${res.status}`);
    } catch (e) {
      bad('Telegram connection', String(e.message || e));
    }
  }

  // 7. AI provider connectivity
  if (key && base) {
    try {
      const t0 = Date.now();
      const res = await fetch(base + '/models', {
        headers: { Authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status < 500) ok('AI provider connection', `${base} → HTTP ${res.status} • ${Date.now() - t0}ms`);
      else bad('AI provider connection', `HTTP ${res.status}`);
    } catch (e) {
      bad('AI provider connection', String(e.message || e));
    }
  }

  // 8. MCP servers (only if configured)
  const mcpServers = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'portable', 'mcp.json'), 'utf8'));
    if (j && Array.isArray(j.servers)) {
      for (const s of j.servers) {
        if (s && s.url && s.enabled !== false) mcpServers.push({ name: s.name || 'srv', url: s.url, auth: s.auth, headers: s.headers });
      }
    }
  } catch { /* no mcp.json */ }
  if (env.JINX_MCP_SERVERS) {
    for (const part of String(env.JINX_MCP_SERVERS).split(/[\n,]+/)) {
      const t = part.trim();
      if (!t || t.startsWith('#')) continue;
      let name = '', url = t;
      const eq = t.indexOf('=');
      if (eq > 0 && /^https?:\/\//i.test(t.slice(eq + 1).trim())) { name = t.slice(0, eq).trim(); url = t.slice(eq + 1).trim(); }
      if (!/^https?:\/\//i.test(url)) continue;
      if (!name) { try { name = new URL(url).hostname.split('.')[0]; } catch { name = 'srv'; } }
      mcpServers.push({ name, url, auth: env['JINX_MCP_AUTH_' + name.toUpperCase()] });
    }
  }
  if (mcpServers.length) {
    for (const s of mcpServers.slice(0, 5)) {
      try {
        const t0 = Date.now();
        const init = await fetch(s.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            ...(s.auth ? { Authorization: s.auth } : {}),
            ...(s.headers || {}),
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jinx-harness-check', version: '2.0.0' } } }),
          signal: AbortSignal.timeout(Number(env.JINX_MCP_TIMEOUT_MS) || 15_000),
        });
        if (!init.ok) { bad('MCP server “' + s.name + '”', 'HTTP ' + init.status + ' — ' + s.url); continue; }
        const sessionId = init.headers.get('mcp-session-id') || undefined;
        const list = await fetch(s.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            ...(s.auth ? { Authorization: s.auth } : {}),
            ...(s.headers || {}),
            ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
          signal: AbortSignal.timeout(Number(env.JINX_MCP_TIMEOUT_MS) || 15_000),
        });
        const j2 = await list.json().catch(() => ({}));
        const n = j2 && j2.result && Array.isArray(j2.result.tools) ? j2.result.tools.length : 0;
        ok('MCP server “' + s.name + '”', n + ' tool(s) • ' + (Date.now() - t0) + 'ms');
      } catch (e) {
        bad('MCP server “' + s.name + '”', String(e.message || e));
      }
    }
  } else {
    ok('MCP servers', 'none configured (optional — see docs/MCP.md)');
  }

  // 9. Disk space
  try {
    const st = fs.statfsSync(dataDir);
    const free = Number(st.bavail) * Number(st.bsize);
    if (free > 100 * 1048576) ok('Free disk space', fmtB(free));
    else warn('Free disk space', `only ${fmtB(free)} — backups may not fit`);
  } catch { /* statfs unavailable */ }

  // report
  console.log('');
  for (const [mark, name, detail] of results) {
    console.log(` ${mark} ${name}${detail ? '  →  ' + detail : ''}`);
  }
  console.log('─'.repeat(52));
  if (failed) {
    console.log(`❌ ${failed} red item(s) — fix those first.`);
    process.exit(1);
  }
  console.log('✅ All green — the agent is ready. Open it in your browser!');
  process.exit(0);
}

main().catch((e) => {
  console.error('self-test crashed:', e);
  process.exit(1);
});
