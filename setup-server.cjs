// ═══════════════════════════════════════════════════════════════════════════
//  Jinx Harness — one-time setup wizard (server)
//
//  Served ONLY while portable/.env is missing BOT_TOKEN/JINX_API_KEY.
//  Once configuration is saved, this server never starts again (the URL
//  returns the normal agent). Reset = delete portable/.env (see README).
//
//  Routes (paths below PORTABLE_BASE_PATH):
//   GET  /                     → 302 to /setup
//   GET  /setup                → wizard page (bilingual, offline, no CDN)
//   GET  /health               → {"status":"setup-required",...}
//   POST /setup/api/test-telegram   {token}
//   POST /setup/api/detect-admin    {token}
//   POST /setup/api/list-models     {baseUrl, apiKey}
//   POST /setup/api/test-provider   {baseUrl, apiKey, model}
//   POST /setup/api/finish          {…full config…}
//  POSTs require ?k=<setupKey> when running behind the CGI gateway.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// On memory-capped shared hosts native fetch dies on first use — install the
// pure-JS shim before any network call (mirrors app.js full-boot behaviour).
try {
  const shim = require('./fetch-shim.cjs');
  if (shim.wasmBroken()) globalThis.fetch = shim.fetch;
} catch { /* keep native fetch */ }

const TG = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');

function start({ port, root, setupKey }) {
  const dataDir = path.join(root, 'portable', 'data');
  const keyFile = path.join(dataDir, 'setup-key.txt');
  let key = null;
  if (setupKey) {
    try {
      key = fs.readFileSync(keyFile, 'utf8').trim();
      if (!key) throw new Error('empty');
    } catch {
      key = crypto.randomBytes(24).toString('hex');
    }
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(keyFile, key + '\n', { mode: 0o600 });
    } catch { /* best-effort */ }
  }

  const base = (process.env.PORTABLE_BASE_PATH || '').replace(/\/+$/, '');

  const server = http.createServer((req, res) => {
    Promise.resolve().then(() => handle(req, res)).catch((e) => {
      console.error('[setup] error:', e && e.stack || e);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      try { res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) })); } catch {}
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log('[jinx-harness] setup wizard → http://127.0.0.1:' + port + (base || '') + '/setup' + (key ? '?k=' + key : ''));
  });
  server.on('error', (e) => {
    console.error('[jinx-harness] setup server cannot bind port ' + port + ': ' + e.message);
    console.error('[jinx-harness] set PORTABLE_PORT in portable/.env to a different port and retry.');
    process.exit(1);
  });
  return server;

  // ── routing ──────────────────────────────────────────────────────────────
  async function handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    let p = u.pathname;
    if (base) {
      if (p === base) p = '/';
      else if (p.startsWith(base + '/')) p = p.slice(base.length) || '/';
      else p = null; // outside base → not ours
    }
    if (p === null) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('not found'); return; }

    if (req.method === 'GET' && p === '/health') {
      json(res, 200, {
        name: 'Jinx Harness (setup)', status: 'setup-required', mode: 'setup',
        version: '9.3.0-oss', pid: process.pid,
      });
      return;
    }
    if (req.method === 'GET' && (p === '/' || p === '')) {
      res.statusCode = 302;
      res.setHeader('Location', base + '/setup' + (key ? '?k=' + key : ''));
      res.end();
      return;
    }
    if (req.method === 'GET' && p === '/setup') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(wizardHtml());
      return;
    }
    if (req.method === 'POST' && p.startsWith('/setup/api/')) {
      if (key && u.searchParams.get('k') !== key) { json(res, 403, { ok: false, error: 'bad setup key' }); return; }
      const body = await readJson(req);
      const action = p.slice('/setup/api/'.length);
      const out = await api(action, body || {});
      json(res, out.code || 200, out.body);
      return;
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('not found');
  }

  // ── API actions ──────────────────────────────────────────────────────────
  async function api(action, b) {
    const t0 = Date.now();
    try {
      if (action === 'test-telegram') {
        const token = String(b.token || '').trim();
        if (!/^\d+:[\w-]{20,}$/.test(token)) return { body: { ok: false, error: 'Token format looks wrong (expect 123456:ABC-DEF…)' } };
        const r = await fetch(TG + '/bot' + token + '/getMe', { signal: AbortSignal.timeout(12_000) });
        const j = await r.json().catch(() => ({}));
        if (j && j.ok) return { body: { ok: true, username: j.result.username, name: j.result.first_name, ms: Date.now() - t0 } };
        return { body: { ok: false, error: (j && j.description) || 'HTTP ' + r.status } };
      }
      if (action === 'detect-admin') {
        const token = String(b.token || '').trim();
        const r = await fetch(TG + '/bot' + token + '/getUpdates?limit=100&timeout=0', { signal: AbortSignal.timeout(12_000) });
        const j = await r.json().catch(() => ({}));
        if (!j || !j.ok) return { body: { ok: false, error: (j && j.description) || 'HTTP ' + r.status } };
        const seen = new Map();
        for (const up of j.result || []) {
          const m = up.message || up.edited_message || up.channel_post || up.my_chat_member;
          const chat = m && m.chat;
          if (chat && chat.type === 'private') seen.set(chat.id, (chat.first_name || '') + (chat.username ? ' (@' + chat.username + ')' : ''));
        }
        return { body: { ok: true, chats: [...seen.entries()].map(([id, name]) => ({ id, name })) } };
      }
      if (action === 'list-models') {
        const baseUrl = String(b.baseUrl || '').trim().replace(/\/+$/, '');
        const apiKey = String(b.apiKey || '').trim();
        if (!/^https?:\/\//.test(baseUrl)) return { body: { ok: false, error: 'Base URL must start with http(s)://' } };
        const r = await fetch(baseUrl + '/models', {
          headers: { Authorization: 'Bearer ' + apiKey },
          signal: AbortSignal.timeout(15_000),
        });
        const j = await r.json().catch(() => null);
        const ids = (j && Array.isArray(j.data) ? j.data : []).map((m) => m && (m.id || m.name)).filter(Boolean).slice(0, 200);
        if (!ids.length) return { body: { ok: false, error: 'No models listed (HTTP ' + r.status + ') — type the model name manually.' } };
        return { body: { ok: true, models: ids } };
      }
      if (action === 'test-provider') {
        const baseUrl = String(b.baseUrl || '').trim().replace(/\/+$/, '');
        const apiKey = String(b.apiKey || '').trim();
        const model = String(b.model || '').trim();
        if (!/^https?:\/\//.test(baseUrl)) return { body: { ok: false, error: 'Base URL must start with http(s)://' } };
        if (!apiKey) return { body: { ok: false, error: 'API key is empty' } };
        if (!model) return { body: { ok: false, error: 'Model name is empty' } };
        const r = await fetch(baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: OK' }], max_tokens: 8 }),
          signal: AbortSignal.timeout(25_000),
        });
        const j = await r.json().catch(() => null);
        const text = j && j.choices && j.choices[0] && (j.choices[0].message || {}).content;
        if (r.status < 400 && j && j.choices) return { body: { ok: true, sample: String(text || '').slice(0, 60) || '(empty)', ms: Date.now() - t0 } };
        const err = (j && (j.error && (j.error.message || j.error) || j.message)) || ('HTTP ' + r.status);
        return { body: { ok: false, error: String(err).slice(0, 300) } };
      }
      if (action === 'finish') { return finish(b); }
      return { code: 404, body: { ok: false, error: 'unknown action' } };
    } catch (e) {
      return { body: { ok: false, error: String(e && e.message || e).slice(0, 300) } };
    }
  }

  // ── write config + schedule restart ──────────────────────────────────────
  function finish(b) {
    const v = {
      BOT_TOKEN: String(b.botToken || '').trim(),
      ADMIN_ID: String(b.adminId || '').trim(),
      JINX_API_KEY: String(b.apiKey || '').trim(),
      JINX_BASE_URL: String(b.baseUrl || '').trim().replace(/\/+$/, ''),
      JINX_MODEL: String(b.model || '').trim(),
      JINX_ALIAS: String(b.alias || '').trim(),
      JINX_BRAND_NAME: String(b.brandName || '').trim() || 'Jinx Harness',
      JINX_MAKER_NAME: String(b.makerName || '').trim(),
      TIMEZONE: String(b.timezone || '').trim() || 'UTC',
      DEFAULT_LANG: String(b.lang || '').trim() === 'fa' ? 'fa' : 'en',
      WEBHOOK_SECRET: crypto.randomBytes(32).toString('hex'),
      PORTABLE_PORT: String(port),
    };
    if (base) v.PORTABLE_BASE_PATH = base;
    if (String(b.persona || '').trim()) v.JINX_PERSONA = String(b.persona).trim();

    if (!/^\d+:[\w-]{20,}$/.test(v.BOT_TOKEN)) return { body: { ok: false, error: 'Telegram token is missing or malformed' } };
    if (!v.ADMIN_ID || !/^\d{3,}$/.test(v.ADMIN_ID)) return { body: { ok: false, error: 'Admin Telegram ID is required (digits only — use the Detect button)' } };
    if (!v.JINX_API_KEY || v.JINX_API_KEY.length < 8) return { body: { ok: false, error: 'AI API key is missing/too short' } };
    if (!/^https?:\/\//.test(v.JINX_BASE_URL)) return { body: { ok: false, error: 'AI base URL must start with http(s)://' } };
    if (!v.JINX_MODEL) return { body: { ok: false, error: 'Model name is required' } };

    const q = (s) => (/^[\w.:@\/+,#!%^&*()\[\]{}<>'"~=;? -]*$/.test(s) && !/\s/.test(s) ? s : JSON.stringify(s));
    const lines = [
      '# Jinx Harness configuration — created by the setup wizard ' + new Date().toISOString(),
      '# Admin panel: /admin?t=' + v.WEBHOOK_SECRET,
      'BOT_TOKEN=' + q(v.BOT_TOKEN),
      'ADMIN_ID=' + q(v.ADMIN_ID),
      '',
      '# AI provider (any OpenAI-compatible endpoint)',
      'JINX_API_KEY=' + q(v.JINX_API_KEY),
      'JINX_BASE_URL=' + q(v.JINX_BASE_URL),
      'JINX_MODEL=' + q(v.JINX_MODEL),
      v.JINX_ALIAS ? 'JINX_ALIAS=' + q(v.JINX_ALIAS) : '# JINX_ALIAS=friendly model name shown in /about',
      '',
      '# Identity',
      'JINX_BRAND_NAME=' + q(v.JINX_BRAND_NAME),
      v.JINX_MAKER_NAME ? 'JINX_MAKER_NAME=' + q(v.JINX_MAKER_NAME) : '# JINX_MAKER_NAME=who made this assistant',
      'TIMEZONE=' + q(v.TIMEZONE),
      'DEFAULT_LANG=' + q(v.DEFAULT_LANG),
      v.JINX_PERSONA ? 'JINX_PERSONA=' + q(v.JINX_PERSONA) : '# JINX_PERSONA=full custom system prompt (optional)',
      '',
      '# Panel/auth',
      'WEBHOOK_SECRET=' + q(v.WEBHOOK_SECRET),
      'PORTABLE_PORT=' + q(v.PORTABLE_PORT),
      base ? 'PORTABLE_BASE_PATH=' + q(base) : '# PORTABLE_BASE_PATH=/subdir (set automatically in CGI mode)',
      '',
      '# Optional search engines (leave empty to use the built-in free engines)',
      '# JINX_TAVILY_KEY=',
      '# JINX_SERPER_KEY=',
      '# JINX_BRAVE_KEY=',
      '# JINX_EXA_KEY=',
      '# JINX_SEARXNG_URLS=',
    ];
    fs.mkdirSync(path.join(root, 'portable'), { recursive: true });
    fs.writeFileSync(path.join(root, 'portable', '.env'), lines.join('\n') + '\n', { mode: 0o600 });
    try { fs.rmSync(keyFile, { force: true }); } catch {} // setup key consumed
    console.log('[jinx-harness] configuration saved — restarting into full mode');

    const adminUrl = (base || '') + '/admin?t=' + v.WEBHOOK_SECRET;
    setTimeout(() => {
      try { server.close(); } catch {}
      try {
        const { spawn } = require('node:child_process');
        const logs = path.join(root, 'portable', 'data', 'logs');
        fs.mkdirSync(logs, { recursive: true });
        const out = fs.openSync(path.join(logs, 'bot-' + new Date().toISOString().slice(0, 10) + '.log'), 'a');
        const child = spawn(process.execPath, [path.join(root, 'app.js')], {
          cwd: root, detached: true, stdio: ['ignore', out, out],
          env: { ...process.env, PORTABLE_PORT: String(port), PORTABLE_BASE_PATH: base || '' },
        });
        child.unref();
      } catch (e) { console.error('[setup] restart spawn failed:', e && e.message); }
      setTimeout(() => process.exit(0), 500);
    }, 600);

    return { body: { ok: true, adminUrl, secret: v.WEBHOOK_SECRET, brand: v.JINX_BRAND_NAME } };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 262144) { req.destroy(); resolve(null); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

// ── wizard page (inline, offline, bilingual EN/FA) ───────────────────────────
function wizardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-${""}8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Jinx Harness — Setup</title>
<style>
:root{--bg:#0b1020;--card:#111731;--line:#232c4f;--txt:#e8ecf8;--mut:#8b94b8;--acc:#7c5cff;--ok:#2fbf71;--err:#ff5c7a}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--txt);font:15px/1.65 Vazirmatn,Tahoma,system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:28px 16px 60px}
.wrap{width:100%;max-width:640px}
header{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.logo{font-size:30px}
h1{font-size:21px;font-weight:700}
.sub{color:var(--mut);font-size:13px}
.langs{margin-left:auto;display:flex;gap:6px}
.langs button{background:var(--card);border:1px solid var(--line);color:var(--mut);border-radius:8px;padding:5px 12px;cursor:pointer;font:inherit}
.langs button.on{color:#fff;border-color:var(--acc);background:rgba(124,92,255,.15)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;margin-bottom:16px}
.card h2{font-size:16px;margin-bottom:4px;display:flex;align-items:center;gap:9px}
.stepn{background:var(--acc);color:#fff;width:23px;height:23px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;flex:none}
.hint{color:var(--mut);font-size:12.5px;margin-bottom:14px}
label{display:block;font-size:13px;color:var(--mut);margin:12px 0 5px}
input,select,textarea{width:100%;background:#0d1329;border:1px solid var(--line);color:var(--txt);border-radius:9px;padding:10px 12px;font:inherit;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--acc)}
textarea{min-height:88px;resize:vertical;font-size:13px}
.row{display:flex;gap:10px}
.row>*{flex:1}
.btn{display:inline-flex;align-items:center;gap:7px;background:var(--acc);color:#fff;border:0;border-radius:9px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer;margin-top:14px}
.btn.sec{background:transparent;border:1px solid var(--line);color:var(--txt)}
.btn:disabled{opacity:.5;cursor:wait}
.msg{margin-top:9px;font-size:13px;padding:9px 12px;border-radius:9px;display:none;word-break:break-word}
.msg.ok{display:block;background:rgba(47,191,113,.12);color:var(--ok)}
.msg.err{display:block;background:rgba(255,92,122,.12);color:var(--err)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.chip{background:#0d1329;border:1px solid var(--acc);color:var(--txt);border-radius:999px;padding:6px 13px;cursor:pointer;font:inherit;font-size:13px}
.final{border-color:var(--ok)}
.secret{background:#0d1329;border:1px dashed var(--line);padding:9px 12px;border-radius:9px;font-family:ui-monospace,monospace;font-size:12.5px;word-break:break-all;margin:8px 0}
a{color:var(--acc)}
.center{text-align:center}
.hide{display:none}
[dir=rtl] body{direction:rtl}
footer{color:var(--mut);font-size:12px;margin-top:26px;text-align:center}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="logo">🤖</div>
  <div><h1 id="t-title">Jinx Harness — Setup</h1><div class="sub" id="t-sub">v9.3.0-oss · one-time configuration</div></div>
  <div class="langs"><button id="btn-en" class="on">EN</button><button id="btn-fa">فارسی</button></div>
</header>

<div class="card" id="done-card" style="display:none">
  <h2>✅ <span id="t-done">Ready!</span></h2>
  <p class="hint" id="t-donehint">Your agent is starting. The setup page is now locked forever.</p>
  <div id="done-body"></div>
</div>

<div id="wizard">
<div class="card">
  <h2><span class="stepn">1</span><span id="t-s1">Telegram bot</span></h2>
  <div class="hint" id="t-s1h">Create a bot with @BotFather → /newbot, then paste the token here.</div>
  <label id="l-token">Bot token</label>
  <input id="token" placeholder="123456789:AAF…">
  <div class="msg" id="m-token"></div>
  <label id="l-admin">Your Telegram user ID</label>
  <div class="row">
    <input id="adminId" inputmode="numeric" placeholder="e.g. 7718338819">
    <button class="btn sec" style="margin-top:0" id="btn-detect" onclick="detect()">🔎 <span id="t-detect">Detect</span></button>
  </div>
  <div class="hint" id="t-adminh">Send any message to your new bot first, then press Detect. (Or get it from @userinfobot.)</div>
  <div class="chips" id="chats"></div>
</div>

<div class="card">
  <h2><span class="stepn">2</span><span id="t-s2">AI provider</span></h2>
  <div class="hint" id="t-s2h">Any OpenAI-compatible endpoint. Nothing is preconfigured — your keys stay on your server.</div>
  <label id="l-base">Base URL</label>
  <input id="baseUrl" placeholder="https://api.openai.com/v1">
  <label id="l-key">API key</label>
  <input id="apiKey" type="password" placeholder="sk-…">
  <label id="l-model">Model</label>
  <div class="row">
    <input id="model" list="models" placeholder="gpt-4o-mini">
    <button class="btn sec" style="margin-top:0" id="btn-models" onclick="loadModels()">↻ <span id="t-loadm">Load</span></button>
  </div>
  <datalist id="models"></datalist>
  <div class="msg" id="m-model"></div>
  <button class="btn sec" onclick="testProvider()">🔌 <span id="t-test">Test connection</span></button>
  <div class="msg" id="m-prov"></div>
</div>

<div class="card">
  <h2><span class="stepn">3</span><span id="t-s3">Identity</span></h2>
  <div class="hint" id="t-s3h">How your agent introduces itself. Fully yours — no built-in branding.</div>
  <label id="l-brand">Agent name</label>
  <input id="brandName" value="Jinx Harness">
  <label id="l-maker">Made by (optional)</label>
  <input id="makerName" placeholder="">
  <div class="row">
    <div><label id="l-tz">Timezone</label>
    <select id="tz">
      <option>UTC</option><option selected>Asia/Tehran</option><option>Europe/Berlin</option><option>Europe/London</option><option>Europe/Paris</option><option>Asia/Dubai</option><option>Asia/Kolkata</option><option>Asia/Shanghai</option><option>Asia/Tokyo</option><option>America/New_York</option><option>America/Chicago</option><option>America/Los_Angeles</option><option>Australia/Sydney</option>
    </select></div>
    <div><label id="l-lang">Default language</label>
    <select id="lang"><option value="en">English</option><option value="fa">فارسی</option></select></div>
  </div>
  <label id="l-persona">Custom persona (optional — leave empty for the built-in one)</label>
  <textarea id="persona" placeholder="You are …"></textarea>
</div>

<div class="card final">
  <h2>🚀 <span id="t-s4">Finish</span></h2>
  <div class="hint" id="t-s4h">This writes portable/.env and restarts the agent. The setup link dies afterwards.</div>
  <button class="btn" id="btn-finish" onclick="finish()">✓ <span id="t-create">Create &amp; start</span></button>
  <div class="msg" id="m-finish"></div>
</div>
</div>

<footer>Jinx Harness · open source (MIT) · after setup: <span dir="ltr">/admin?t=…</span> · reset = delete <span dir="ltr">portable/.env</span></footer>
</div>
<script>
const K = new URLSearchParams(location.search).get('k') || '';
const $ = (id) => document.getElementById(id);
const say = (id, ok, text) => { const m = $(id); m.className = 'msg ' + (ok ? 'ok' : 'err'); m.textContent = text; };
const api = (action, body) => fetch('setup/api/' + action + (K ? '?k=' + encodeURIComponent(K) : ''), {
  method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body||{})
}).then(r => r.json()).catch(e => ({ok:false, error:String(e)}));

const L = {
  en: {title:'Jinx Harness — Setup', sub:'v9.3.0-oss · one-time configuration',
    s1:'Telegram bot', s1h:'Create a bot with @BotFather → /newbot, then paste the token here.',
    token:'Bot token', admin:'Your Telegram user ID',
    adminh:'Send any message to your new bot first, then press Detect. (Or get it from @userinfobot.)',
    detect:'Detect', s2:'AI provider', s2h:'Any OpenAI-compatible endpoint. Nothing is preconfigured — your keys stay on your server.',
    base:'Base URL', key:'API key', model:'Model', loadm:'Load', test:'Test connection',
    s3:'Identity', s3h:'How your agent introduces itself. Fully yours — no built-in branding.',
    brand:'Agent name', maker:'Made by (optional)', tz:'Timezone', lang:'Default language',
    persona:'Custom persona (optional — leave empty for the built-in one)',
    s4:'Finish', s4h:'This writes portable/.env and restarts the agent. The setup link dies afterwards.',
    create:'Create & start', done:'Ready!', donehint:'Your agent is starting. The setup page is now locked forever.',
    testing:'Testing…', loading:'Loading…', saved:'Saved ✓'},
  fa: {title:'جینکس ایجنت — راه‌اندازی', sub:'نسخه ۹.۳.۰-اوپن‌سورس · تنظیم یک‌باره',
    s1:'ربات تلگرام', s1h:'با @BotFather دستور /newbot را بزن و توکن را اینجا بچسبان.',
    token:'توکن ربات', admin:'آیدی عددی تلگرام خودت',
    adminh:'اول یک پیام به رباتت بده، بعد دکمه «شناسایی» را بزن. (یا از @userinfobot بگیر.)',
    detect:'شناسایی', s2:'پرووایدر هوش مصنوعی', s2h:'هر endpoint سازگار با OpenAI. هیچ چیز از پیش تنظیم نشده — کلیدها فقط روی سرور خودت می‌ماند.',
    base:'آدرس Base URL', key:'کلید API', model:'مدل', loadm:'دریافت', test:'تست اتصال',
    s3:'هویت', s3h:'ایجنت چطور خودش را معرفی کند. کاملاً اختیاریِ تو — هیچ برند از پیش تعیین‌شده‌ای وجود ندارد.',
    brand:'نام ایجنت', maker:'ساختهٔ (اختیاری)', tz:'منطقهٔ زمانی', lang:'زبان پیش‌فرض',
    persona:'پرسونای سفارشی (اختیاری — خالی بگذار تا پیش‌فرض استفاده شود)',
    s4:'پایان', s4h:'این مرحله فایل portable/.env را می‌نویسد و ایجنت را ری‌استارت می‌کند. لینک راه‌اندازی بعد از آن برای همیشه بسته می‌شود.',
    create:'ساخت و شروع', done:'آماده شد!', donehint:'ایجنت در حال بالا آمدن است. صفحهٔ راه‌اندازی از این پس برای همیشه قفل است.',
    testing:'در حال تست…', loading:'در حال دریافت…', saved:'ذخیره شد ✓'}
};
let lang = (navigator.language||'').toLowerCase().startsWith('fa') ? 'fa' : 'en';
function applyLang(){
  document.documentElement.lang = lang; document.documentElement.dir = lang==='fa' ? 'rtl' : 'ltr';
  const t = L[lang];
  for (const [id, k] of [['t-title','title'],['t-sub','sub'],['t-s1','s1'],['t-s1h','s1h'],['l-token','token'],['l-admin','admin'],['t-adminh','adminh'],['t-detect','detect'],['t-s2','s2'],['t-s2h','s2h'],['l-base','base'],['l-key','key'],['l-model','model'],['t-loadm','loadm'],['t-test','test'],['t-s3','s3'],['t-s3h','s3h'],['l-brand','brand'],['l-maker','maker'],['l-tz','tz'],['l-lang','lang'],['l-persona','persona'],['t-s4','s4'],['t-s4h','s4h'],['t-create','create'],['t-done','done'],['t-donehint','donehint']])
    { const el = $(id); if (el) el.textContent = t[k]; }
  $('btn-en').className = lang==='en' ? 'on' : ''; $('btn-fa').className = lang==='fa' ? 'on' : '';
  $('lang').value = lang;
}
$('btn-en').onclick = () => { lang='en'; applyLang(); };
$('btn-fa').onclick = () => { lang='fa'; applyLang(); };
applyLang();

async function detect(){
  const b = $('btn-detect'); b.disabled = true;
  say('m-token', true, L[lang].loading);
  const r = await api('test-telegram', {token: $('token').value.trim()});
  say('m-token', r.ok, r.ok ? ('✓ @' + r.username) : (r.error||'failed'));
  if (!r.ok) { b.disabled = false; return; }
  const d = await api('detect-admin', {token: $('token').value.trim()});
  b.disabled = false;
  const box = $('chats'); box.innerHTML = '';
  if (d.ok && d.chats && d.chats.length) {
    for (const c of d.chats) {
      const el = document.createElement('button');
      el.className = 'chip'; el.textContent = (c.name || c.id) + ' · ' + c.id;
      el.onclick = () => { $('adminId').value = c.id; };
      box.appendChild(el);
    }
  } else say('m-token', false, d.error || 'No recent chats found — send /start to your bot first.');
}
async function loadModels(){
  const b = $('btn-models'); b.disabled = true;
  say('m-model', true, L[lang].loading);
  const r = await api('list-models', {baseUrl: $('baseUrl').value.trim(), apiKey: $('apiKey').value.trim()});
  b.disabled = false;
  if (r.ok) {
    const dl = $('models'); dl.innerHTML = '';
    for (const m of r.models) { const o = document.createElement('option'); o.value = m; dl.appendChild(o); }
    say('m-model', true, '✓ ' + r.models.length + ' models — start typing to pick one');
    $('model').focus();
  } else say('m-model', false, r.error || 'failed');
}
async function testProvider(){
  say('m-prov', true, L[lang].testing);
  const r = await api('test-provider', {baseUrl: $('baseUrl').value.trim(), apiKey: $('apiKey').value.trim(), model: $('model').value.trim()});
  say('m-prov', !!r.ok, r.ok ? ('✓ ' + (r.sample||'OK') + ' (' + r.ms + 'ms)') : (r.error || 'failed'));
}
async function finish(){
  const b = $('btn-finish'); b.disabled = true;
  say('m-finish', true, L[lang].testing);
  const r = await api('finish', {
    botToken: $('token').value.trim(), adminId: $('adminId').value.trim(),
    baseUrl: $('baseUrl').value.trim(), apiKey: $('apiKey').value.trim(), model: $('model').value.trim(),
    brandName: $('brandName').value.trim(), makerName: $('makerName').value.trim(),
    timezone: $('tz').value, lang: $('lang').value, persona: $('persona').value
  });
  if (!r.ok) { say('m-finish', false, r.error || 'failed'); b.disabled = false; return; }
  $('wizard').style.display = 'none';
  const c = $('done-card'); c.style.display = '';
  $('done-body').innerHTML =
    '<div class="secret">Admin panel token: ' + r.secret + '</div>' +
    '<p class="hint">' + (lang==='fa'
      ? 'چند ثانیه صبر کن تا ایجنت بالا بیاید، بعد پنل مدیریت را باز کن:'
      : 'Wait a few seconds for the agent to boot, then open the admin panel:') + '</p>' +
    '<p class="center"><a class="btn" style="text-decoration:none" href="' + r.adminUrl + '">📊 ' + (lang==='fa'?'پنل مدیریت':'Admin panel') + '</a></p>' +
    '<p class="hint center">' + (lang==='fa'
      ? 'برای پایداری ۲۴/۷ یک کرون هر ۵ دقیقه بگذار (راهنما در README).'
      : 'For 24/7 reliability add a 5-minute cron (see README).') + '</p>';
}
</script>
</body>
</html>`;
}

module.exports = { start };
