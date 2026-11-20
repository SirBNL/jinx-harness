// ═══════════════════════════════════════════════════════════════════════════
//  Jinx Harness v2.1 — MCP bridge  ("Give any model hands." — all the hands)
//
//  Connects the agent to ANY Model Context Protocol server over Streamable
//  HTTP (the 2025-06-18 transport). Every tool a server exposes becomes a
//  first-class agent tool named `mcp_<server>_<tool>`, usable by any model —
//  including models with no native tool-calling of their own.
//
//  v2.1 — the agent can now connect servers ITSELF, with a human permission
//  gate at connect time, and servers that require a LOGIN (OAuth) or an API
//  key are first-class citizens:
//    • mcp_connect(url, name?, apiKey?)   — asks the owner via the 🔐 approval
//      card, then preflights the server and connects it (no auth / API key /
//      OAuth). Approved servers persist in portable/data/mcp-dynamic.json.
//    • mcp_disconnect(name)               — admin-only removal.
//    • mcp_oauth_complete(url_or_code)    — finishes an OAuth flow from a URL
//      the user pasted back into the chat (fallback when the browser cannot
//      reach /oauth/mcp/callback).
//    • OAuth: PKCE (S256) + Dynamic Client Registration + auto token refresh
//      (mcp-oauth.cjs) — the Higgsfield / Runway / HeyGen pattern.
//
//  Zero dependencies. Loads lazily from dist/portable.cjs; if this file is
//  missing or fails, the agent keeps working exactly as before.
//
//  Configuration (owner-configured servers — either one, mcp.json wins):
//    1) portable/mcp.json:
//         { "servers": [ { "name": "fetch", "url": "https://…/mcp",
//                          "auth": "Bearer xyz",            // Authorization header
//                          "headers": { "X-Api-Key": "…" }, // any extra headers
//                          "enabled": true, "timeoutMs": 30000 } ] }
//    2) JINX_MCP_SERVERS="fetch=https://…/mcp, https://other/mcp"
//       plus optional JINX_MCP_AUTH_<NAME>="Bearer xyz"
//    3) the agent itself via mcp_connect (persists to mcp-dynamic.json)
//
//  Env knobs: JINX_MCP_TIMEOUT_MS (per-request, default 30000)
//             JINX_MCP_MAX_TOOLS  (default 300)
//             JINX_MCP_OFF=1      (disable the bridge entirely)
//             JINX_MCP_ALLOW_CONNECT=0  (disable agent self-connect)
//             JINX_MCP_JSON / JINX_MCP_REGISTRY / JINX_MCP_DYNAMIC (paths)
//             JINX_PUBLIC_URL     (public CGI base — needed for OAuth)
//
//  Security posture:
//   • mcp_connect / mcp_disconnect are ADMIN-ONLY, and every connect passes
//     the engine's human approval card (allow / deny / allow-for-this-run)
//     before any request leaves the host.
//   • Owner-configured servers (files on disk) are trusted as before.
//   • OAuth tokens and API keys are stored chmod-600 and never logged.
//   • Tool output is capped (48 KB) before it enters the model context.
//   • Non-admin callers still pass the engine's tool-budget + approval gate.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// resolve repo root: this file sits at <root>/mcp-bridge.cjs and is required
// by <root>/dist/portable.cjs — but stay robust if the tree is relocated.
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'portable', 'data');
function envPath(k, d) { const v = process.env[k]; return v && String(v).trim() ? path.resolve(String(v).trim()) : d; }
const MCP_JSON = envPath('JINX_MCP_JSON', path.join(ROOT, 'portable', 'mcp.json'));
const REGISTRY = envPath('JINX_MCP_REGISTRY', path.join(DATA_DIR, 'mcp-registry.json'));
const DYNAMIC = envPath('JINX_MCP_DYNAMIC', path.join(DATA_DIR, 'mcp-dynamic.json'));

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'jinx-harness', version: '2.1.0' };
const RESULT_CAP = 48 * 1024;          // max tool output pushed into context
const DESC_CAP = 900;                  // max description length per tool
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TOOLS_DEFAULT = 300;
const REGISTRY_TTL_MS = 6 * 3600_000;  // cached tools older than this re-scan eagerly

// ── tiny env shim: values may come from process.env (app.js already merged
//    portable/.env into it before the bundle boots) ─────────────────────────
function envStr(k, d) { const v = process.env[k]; return v === undefined || v === '' ? d : v; }
function envInt(k, d) { const v = parseInt(process.env[k], 10); return Number.isFinite(v) && v > 0 ? v : d; }

// lazy oauth module (avoid a require cycle at load time)
let _oauth = null;
function oauth() {
  if (_oauth === null) { try { _oauth = require('./mcp-oauth.cjs'); } catch { _oauth = false; } }
  return _oauth || null;
}

// ── logging (mirrors engine style; never logs secrets) ─────────────────────
function log(line) {
  try { console.log('[jinx-mcp] ' + line); } catch { /* stdout closed on CGI hosts */ }
}

// ── config parsing ──────────────────────────────────────────────────────────
function sanitizeName(s, fallback) {
  const t = String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  return t || fallback;
}

function parseEnvServers(env) {
  const raw = (env && env.JINX_MCP_SERVERS) || envStr('JINX_MCP_SERVERS', '');
  const out = [];
  for (const part of raw.split(/[\n,]+/)) {
    const t = part.trim();
    if (!t || t.startsWith('#')) continue;
    let name = '', url = t;
    const eq = t.indexOf('=');
    if (eq > 0 && /^https?:\/\//i.test(t.slice(eq + 1).trim())) {
      name = sanitizeName(t.slice(0, eq), '');
      url = t.slice(eq + 1).trim();
    }
    if (!/^https?:\/\//i.test(url)) continue;
    if (!name) {
      try { name = sanitizeName(new URL(url).hostname.split('.')[0], 'srv'); } catch { name = 'srv'; }
    }
    const auth = envStr('JINX_MCP_AUTH_' + name.toUpperCase(), '');
    out.push({ name, url, auth: auth || undefined, enabled: true });
  }
  return out;
}

function parseJsonServers(file) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!j || !Array.isArray(j.servers)) return null;
  const out = [];
  for (const s of j.servers) {
    if (!s || typeof s !== 'object' || !/^https?:\/\//i.test(String(s.url || ''))) continue;
    out.push({
      name: sanitizeName(s.name, ''),
      url: String(s.url).trim(),
      auth: s.auth ? String(s.auth) : undefined,
      headers: (s.headers && typeof s.headers === 'object') ? s.headers : undefined,
      enabled: s.enabled !== false,
      timeoutMs: Number(s.timeoutMs) > 1000 ? Number(s.timeoutMs) : undefined,
    });
  }
  return out.filter((s) => s.name);
}

function loadDynamic() {
  try {
    const j = JSON.parse(fs.readFileSync(DYNAMIC, 'utf8'));
    const out = [];
    for (const s of (Array.isArray(j.servers) ? j.servers : [])) {
      if (!s || !/^https?:\/\//i.test(String(s.url || ''))) continue;
      const name = sanitizeName(s.name, '');
      if (!name) continue;
      out.push({
        name, url: String(s.url).trim(),
        auth: s.auth ? String(s.auth) : undefined,
        headers: (s.headers && typeof s.headers === 'object') ? s.headers : undefined,
        enabled: s.enabled !== false, source: 'agent', addedAt: s.addedAt,
      });
    }
    return out;
  } catch { return []; }
}

function saveDynamic() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const servers = state.servers.filter((s) => s.source === 'agent').map((s) => ({
      name: s.name, url: s.url, auth: s.auth, headers: s.headers, enabled: s.enabled !== false, addedAt: s.addedAt || Date.now(),
    }));
    fs.writeFileSync(DYNAMIC, JSON.stringify({ version: 1, savedAt: Date.now(), servers }, null, 2));
    try { fs.chmodSync(DYNAMIC, 0o600); } catch { /* shared hosts */ }
  } catch { /* read-only data dir — dynamic store is best-effort */ }
}

function loadConfig() {
  if (envStr('JINX_MCP_OFF', '') === '1') return [];
  const out = [];
  const fromJson = parseJsonServers(MCP_JSON);
  if (fromJson && fromJson.length) out.push(...fromJson);
  else out.push(...parseEnvServers(process.env));
  const seenUrl = new Set(out.map((s) => s.url));
  for (const d of loadDynamic()) {
    if (seenUrl.has(d.url)) continue;
    seenUrl.add(d.url);
    out.push(d);
  }
  return out;
}

// ── JSON-RPC over Streamable HTTP ──────────────────────────────────────────
function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; }

/** Parse an SSE body (string) into JSON-RPC messages for our request id. */
function sseMessages(body, wantId) {
  const msgs = [];
  for (const block of String(body).split(/\r?\n\r?\n/)) {
    let data = '';
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trimStart();
    }
    if (!data || data === '[DONE]') continue;
    try {
      const j = JSON.parse(data);
      if (wantId === undefined || j.id === wantId) msgs.push(j);
    } catch { /* keep scanning */ }
  }
  return msgs;
}

/** Read a fetch Response that may be application/json OR text/event-stream. */
async function readRpc(res, wantId) {
  const ct = String(res.headers.get('content-type') || '');
  if (/text\/event-stream/i.test(ct)) {
    const body = await res.text(); // engine fetch shim supports full read
    const msgs = sseMessages(body, wantId);
    if (!msgs.length) throw new Error('MCP server returned an SSE stream with no message for this request');
    return msgs[msgs.length - 1];
  }
  const txt = await res.text();
  if (!txt) throw new Error('MCP server returned an empty body (HTTP ' + res.status + ')');
  try { return JSON.parse(txt); } catch { throw new Error('MCP server returned non-JSON body: ' + clip(txt, 120)); }
}

/** POST one JSON-RPC message; returns { msg, sessionId }. */
async function rpc(url, payload, opts) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...(opts.headers || {}),
  };
  if (opts.auth) headers['Authorization'] = opts.auth;
  if (opts.sessionId) headers['Mcp-Session-Id'] = opts.sessionId;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS),
  });

  if (res.status === 404 && payload.method === 'initialize') {
    throw new Error('server does not expose Streamable HTTP at this URL (404) — check the endpoint path (most servers serve /mcp)');
  }
  if (res.status === 405 && payload.method === 'initialize') {
    throw new Error('server rejected POST (405) — this looks like a legacy SSE-only endpoint; use the server\'s Streamable HTTP /mcp URL instead');
  }
  if (res.status === 401 || res.status === 403) {
    const err = new Error('authentication rejected (HTTP ' + res.status + ') — check auth/headers config');
    err.authRejected = true;
    throw err;
  }
  if (res.status >= 500) {
    throw new Error('server error (HTTP ' + res.status + ')');
  }
  // notifications may answer 202 with empty body — fine
  if (payload.id === undefined) {
    try { await res.text(); } catch { /* discard */ }
    return { msg: null, sessionId: res.headers.get('mcp-session-id') || opts.sessionId };
  }
  if (res.status !== 200 && res.status !== 201) {
    let detail = '';
    try { detail = clip(await res.text(), 160); } catch { /* ignore */ }
    throw new Error('unexpected HTTP ' + res.status + (detail ? ': ' + detail : ''));
  }
  const msg = await readRpc(res, payload.id);
  if (msg.error) {
    throw new Error('JSON-RPC error ' + (msg.error.code || 0) + ': ' + clip(msg.error.message || '', 200));
  }
  return { msg, sessionId: res.headers.get('mcp-session-id') || opts.sessionId };
}

// ── registry / tool registry ────────────────────────────────────────────────
const state = {
  installed: false,
  sec: null,           // { requestApproval(ctx, name, args) } from the engine
  servers: [],        // resolved config entries (static + dynamic)
  live: new Map(),    // name -> { ok, error, tools:[…], sessionId, serverVersion, checkedAt }
  ALL_TOOLS: null,
  BY_NAME: null,
  refreshing: null,   // in-flight discovery promise
};

function toolRecord(srv, t) {
  return {
    server: srv.name,
    orig: t.name,
    name: 'mcp_' + sanitizeName(srv.name, 'srv') + '_' + sanitizeName(t.name, 'tool'),
    description: clip('[mcp:' + srv.name + '] ' + String(t.description || ('Tool "' + t.name + '" on MCP server "' + srv.name + '".')), DESC_CAP),
    inputSchema: normalizeSchema(t.inputSchema),
  };
}

/** Keep what OpenAI-compatible providers accept; drop noisy keywords. */
function normalizeSchema(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    return { type: 'object', properties: { value: { type: 'string' } } };
  }
  const clean = (node, depth) => {
    if (node === null || node === undefined || typeof node !== 'object') return node; // primitives pass through
    if (Array.isArray(node)) return node.map((n) => clean(n, depth + 1));
    if (depth > 8) return {};
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$schema' || k === 'additionalProperties') continue;
      out[k] = clean(v, depth + 1);
    }
    return out;
  };
  const n = clean(s, 0);
  if (n.type !== 'object') return { type: 'object', properties: { value: n } };
  return n;
}

function makeTool(rec, srvCfg) {
  return {
    meta: {
      name: rec.name,
      group: 'mcp',
      emoji: '🔌',
      spec: {
        type: 'function',
        function: {
          name: rec.name,
          description: rec.description,
          parameters: rec.inputSchema,
        },
      },
    },
    handler: async (_ctx, args) => {
      const t0 = Date.now();
      const r = await callTool(srvCfg, rec, args || {});
      const ms = Date.now() - t0;
      if (r.isError) return { error: clip(r.text || 'MCP tool reported an error', 2000) + ' (' + ms + 'ms)' };
      const text = clip(r.text, RESULT_CAP);
      return {
        mcp: { server: srvCfg.name, tool: rec.orig, ms },
        content: text || '(empty result)',
      };
    },
  };
}

// ── auth resolution: static value wins, then OAuth token (mcp-oauth.cjs) ──
async function authFor(srvCfg, opts = {}) {
  if (srvCfg.auth) return srvCfg.auth;
  const o = oauth();
  if (!o) return undefined;
  try { return await o.authHeaderFor(srvCfg.url, { force: !!opts.forceRefresh }) || undefined; }
  catch { return undefined; }
}
function hasToken(srvCfg) {
  const o = oauth();
  if (!o) return false;
  try { return o.tokenStatus().some((t) => t.url === srvCfg.url && t.ok); } catch { return false; }
}

async function handshake(srvCfg, opts = {}) {
  const timeoutMs = srvCfg.timeoutMs || envInt('JINX_MCP_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const doInit = async (auth) => rpc(srvCfg.url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
  }, { headers: srvCfg.headers, auth, timeoutMs });

  let auth = await authFor(srvCfg, { force: !!opts.forceRefresh });
  let out;
  try {
    out = await doInit(auth);
  } catch (e) {
    // stale OAuth token → force one refresh, then retry
    if (e && e.authRejected && !srvCfg.auth && !opts.forceRefresh && hasToken(srvCfg)) {
      auth = await authFor(srvCfg, { force: true });
      out = await doInit(auth);
    } else {
      throw e;
    }
  }
  const { msg, sessionId } = out;
  const serverVersion = (msg.result && msg.result.serverInfo && msg.result.serverInfo.name) || 'unknown';
  try {
    await rpc(srvCfg.url, { jsonrpc: '2.0', method: 'notifications/initialized' },
      { headers: srvCfg.headers, auth, sessionId, timeoutMs: Math.min(timeoutMs, 10_000) });
  } catch { /* some servers skip the ack — non-fatal */ }
  if (sessionId && state.live.has(srvCfg.name)) state.live.get(srvCfg.name).sessionId = sessionId;
  return sessionId;
}

async function listTools(srvCfg, sessionId) {
  const timeoutMs = srvCfg.timeoutMs || envInt('JINX_MCP_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const auth = await authFor(srvCfg);
  const tools = [];
  let cursor = undefined;
  for (let page = 0; page < 5; page++) {
    const { msg } = await rpc(srvCfg.url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: cursor ? { cursor } : {},
    }, { headers: srvCfg.headers, auth, sessionId, timeoutMs });
    const r = msg.result || {};
    for (const t of Array.isArray(r.tools) ? r.tools : []) {
      if (t && t.name) tools.push(t);
    }
    cursor = r.nextCursor || undefined;
    if (!cursor) break;
  }
  return tools;
}

async function callTool(srvCfg, rec, args) {
  const live = state.live.get(srvCfg.name);
  let sessionId = live && live.sessionId;
  // Session expired (400 on call) → re-initialize once, then retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const auth = await authFor(srvCfg);
      const { msg } = await rpc(srvCfg.url, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: rec.orig, arguments: args },
      }, { headers: srvCfg.headers, auth, sessionId, timeoutMs: srvCfg.timeoutMs || envInt('JINX_MCP_TIMEOUT_MS', DEFAULT_TIMEOUT_MS) });
      const res = msg.result || {};
      const parts = [];
      for (const c of Array.isArray(res.content) ? res.content : []) {
        if (c && c.type === 'text' && c.text) parts.push(String(c.text));
        else if (c && c.type === 'resource' && c.resource && c.resource.text) parts.push(String(c.resource.text));
        else if (c && typeof c.text === 'string') parts.push(c.text);
      }
      if (res.structuredContent && typeof res.structuredContent === 'object') {
        try { parts.push(JSON.stringify(res.structuredContent, null, 2)); } catch { /* ignore */ }
      }
      return { text: parts.join('\n\n'), isError: !!res.isError };
    } catch (e) {
      const retryable = attempt === 0 && /session|expired|400|not initialized/i.test(String(e && e.message));
      if (!retryable) throw e;
      sessionId = await handshake(srvCfg); // re-init, updates live.sessionId
    }
  }
  return { text: '', isError: true };
}

// ── sync tools into the engine's registries (idempotent) ───────────────────
function syncTools() {
  if (!state.ALL_TOOLS || !state.BY_NAME) return { added: 0, removed: 0, skipped: 0 };
  const maxTools = envInt('JINX_MCP_MAX_TOOLS', MAX_TOOLS_DEFAULT);

  // drop previous MCP tools
  let removed = 0;
  for (let i = state.ALL_TOOLS.length - 1; i >= 0; i--) {
    if (state.ALL_TOOLS[i] && state.ALL_TOOLS[i].meta && state.ALL_TOOLS[i].meta.group === 'mcp' &&
        !META_TOOL_NAMES.has(state.ALL_TOOLS[i].meta.name)) {
      state.BY_NAME.delete(state.ALL_TOOLS[i].meta.name);
      state.ALL_TOOLS.splice(i, 1);
      removed++;
    }
  }

  // collect desired records
  const wanted = [];
  const seen = new Set(state.BY_NAME.keys());
  let skipped = 0;
  for (const srv of state.servers) {
    const live = state.live.get(srv.name);
    if (!live || !live.ok || !Array.isArray(live.tools)) continue;
    for (const rec of live.tools) {
      if (wanted.length >= maxTools) { skipped++; continue; }
      let name = rec.name, n = 2;
      while (seen.has(name)) { name = rec.name + '_' + n++; if (n > 99) break; }
      if (seen.has(name)) { skipped++; continue; }
      seen.add(name);
      wanted.push({ ...rec, name });
    }
  }

  for (const rec of wanted) {
    const srv = state.servers.find((s) => s.name === rec.server);
    const t = makeTool(rec, srv);
    state.ALL_TOOLS.push(t);
    state.BY_NAME.set(t.meta.name, t);
  }
  return { added: wanted.length, removed, skipped };
}

function saveRegistry() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const servers = [];
    for (const srv of state.servers) {
      const live = state.live.get(srv.name) || {};
      servers.push({
        name: srv.name, url: srv.url,
        ok: !!live.ok, error: live.error || undefined,
        serverVersion: live.serverVersion || undefined,
        checkedAt: live.checkedAt || 0,
        tools: (live.tools || []).map((t) => ({ server: t.server, orig: t.orig, name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    }
    fs.writeFileSync(REGISTRY, JSON.stringify({ version: 2, savedAt: Date.now(), servers }, null, 2));
  } catch { /* read-only data dir — cache is best-effort */ }
}

function loadRegistryCache() {
  try {
    const j = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    if (!j || j.version !== 2 || !Array.isArray(j.servers)) return false;
    let any = false;
    for (const s of j.servers) {
      if (!s || !Array.isArray(s.tools) || !s.tools.length) continue;
      state.live.set(s.name, {
        ok: true, stale: true, sessionId: undefined, serverVersion: s.serverVersion,
        checkedAt: s.checkedAt || 0, error: undefined,
        tools: s.tools.filter((t) => t && t.orig && t.inputSchema),
      });
      any = true;
    }
    return any;
  } catch { return false; }
}

// ── discovery ───────────────────────────────────────────────────────────────
async function discoverOne(srv) {
  const t0 = Date.now();
  try {
    const sessionId = await handshake(srv);
    const raw = await listTools(srv, sessionId);
    state.live.set(srv.name, {
      ok: true, sessionId, serverVersion: '', checkedAt: Date.now(),
      tools: raw.map((t) => toolRecord(srv, t)),
      ms: Date.now() - t0,
    });
    return { name: srv.name, ok: true, tools: raw.length, ms: Date.now() - t0 };
  } catch (e) {
    state.live.set(srv.name, { ok: false, error: clip(e && e.message ? e.message : String(e), 300), checkedAt: Date.now(), tools: [] });
    return { name: srv.name, ok: false, error: clip(e && e.message ? e.message : String(e), 300) };
  }
}

async function discover() {
  const results = await Promise.all(state.servers.filter((s) => s.enabled !== false).map(discoverOne));
  const r = syncTools();
  saveRegistry();
  return { servers: results, ...r };
}

function refresh() {
  if (!state.refreshing) {
    state.refreshing = discover().catch((e) => {
      log('discovery crashed: ' + clip(e && e.message ? e.message : String(e), 200));
      return { servers: [], added: 0, removed: 0, skipped: 0 };
    }).finally(() => { state.refreshing = null; });
  }
  return state.refreshing;
}

// ── agent-driven connect / disconnect (v2.1) ───────────────────────────────
async function connectNow(url, opts = {}) {
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'آدرس سرور باید http/https باشد / url must be http(s)' };

  let srv = state.servers.find((s) => s.url === url);
  if (!srv) {
    let name = sanitizeName(opts.name, '');
    if (!name) { try { name = sanitizeName(new URL(url).hostname.split('.')[0], 'srv'); } catch { name = 'srv'; } }
    let base = name, n = 2;
    while (state.servers.some((s) => s.name === name)) name = base + '_' + (n++);
    srv = {
      name, url,
      auth: opts.auth ? String(opts.auth) : undefined,
      headers: (opts.headers && typeof opts.headers === 'object') ? opts.headers : undefined,
      enabled: true, source: 'agent', addedAt: Date.now(),
    };
    state.servers.push(srv);
    saveDynamic();
    log('agent-connected server registered: ' + srv.name + ' → ' + clip(url, 80));
  } else if (opts.auth || opts.headers) {
    if (opts.auth) srv.auth = String(opts.auth);
    if (opts.headers) srv.headers = opts.headers;
    saveDynamic();
  }

  const r = await discoverOne(srv);
  syncTools();
  saveRegistry();
  if (r.ok) {
    return {
      ok: true, server: srv.name, tools: r.tools, ms: r.ms,
      content: '✅ متصل شد: ' + srv.name + ' — ' + r.tools + ' ابزار با پیشوند mcp_' + srv.name + '_ ثبت شد. برای فهرست: mcp_servers.',
    };
  }
  return { ok: false, error: 'اتصال به ' + srv.name + ' ناموفق بود — ' + r.error + ' — سرور ثبت شد ولی ابزارها واکشی نشدند؛ بعد از رفع مشکل mcp_refresh را صدا بزن.' };
}

async function disconnectServer(name) {
  const srv = state.servers.find((s) => s.name === sanitizeName(name, '\0'));
  if (!srv) return { ok: false, error: 'سروری با این نام وصل نیست: ' + name };
  if (srv.source !== 'agent') {
    return { ok: false, error: 'این سرور توسط مالک در فایل کانفیگ تعریف شده — برای حذفش portable/mcp.json یا JINX_MCP_SERVERS را ویرایش کن (docs/MCP.md).' };
  }
  state.servers = state.servers.filter((s) => s !== srv);
  state.live.delete(srv.name);
  saveDynamic();
  const r = syncTools();
  saveRegistry();
  return { ok: true, removed: srv.name, toolsRemoved: r.removed, content: '🔌 سرور ' + srv.name + ' قطع شد و ' + r.removed + ' ابزارش حذف شد.' };
}

/** Human permission gate — the engine's 🔐 approval card (allow/deny buttons). */
async function requestPermission(ctx, url, name) {
  if (!state.sec || typeof state.sec.requestApproval !== 'function') {
    return { error: 'در این باندل درخواست مجوز در دسترس نیست (هوک v2 نصب نیست) — سرور را از portable/mcp.json اضافه کن. docs/MCP.md' };
  }
  let decision = null;
  try {
    decision = await state.sec.requestApproval(ctx, 'mcp_connect', { url, name });
  } catch (e) {
    return { error: 'دروازهٔ مجوز خطا داد — ' + clip(e && e.message, 160) };
  }
  if (decision && decision.error) {
    return { error: '🚫 اتصال مجاز نشد — ' + decision.error + ' دوباره امتحان نکن؛ اگر کاربر خودش خواست، درخواست جدید بده.' };
  }
  return null; // approved
}

// ── meta tools (always present when bridge loads) ──────────────────────────
const META_TOOL_NAMES = new Set(['mcp_servers', 'mcp_refresh', 'mcp_connect', 'mcp_disconnect', 'mcp_oauth_complete']);

function metaTools() {
  const t = (name, description, parameters, handler) => ({
    meta: { name, group: 'mcp', emoji: '🔌', spec: { type: 'function', function: { name, description, parameters } } },
    handler,
  });
  return [
    t('mcp_servers',
      'List the MCP (Model Context Protocol) servers this agent is connected to, with status and tool counts. Set refresh:true to re-scan for new tools first (use after the owner edits mcp config or completed an OAuth login).',
      { type: 'object', properties: { refresh: { type: 'boolean', description: 'Re-run discovery before listing' } } },
      async (_ctx, args) => {
        if (args && args.refresh) await refresh();
        const servers = state.servers.map((s) => {
          const live = state.live.get(s.name) || {};
          return {
            server: s.name, url: s.url, status: live.ok ? (live.stale ? 'cached' : 'ok') : 'error',
            tools: Array.isArray(live.tools) ? live.tools.length : 0,
            source: s.source === 'agent' ? 'agent-connected' : 'owner-config',
            error: live.error || undefined,
          };
        });
        if (!servers.length) {
          return { content: 'هیچ سرور MCP وصل نیست — از mcp_connect می‌توانی (با اجازهٔ مالک) سرور جدید وصل کنی. راهنما: docs/MCP.md\nNo MCP servers connected yet — see docs/MCP.md', servers: [] };
        }
        const lines = servers.map((s) =>
          '• ' + s.server + ' — ' + s.status + ' (' + s.tools + ' ابزار/tool, ' + s.source + ')' + (s.error ? ' — خطا: ' + s.error : ''));
        return { servers, content: lines.join('\n') };
      }),
    t('mcp_refresh',
      'Re-scan all configured MCP servers and register any new tools. Use when the owner says they added or changed an MCP server, after an OAuth login completed, or when an expected mcp_<server>_<tool> tool seems missing.',
      { type: 'object', properties: {} },
      async () => {
        const r = await refresh();
        const lines = r.servers.map((s) => '• ' + s.name + ': ' + (s.ok ? 'ok (' + s.tools + ' tools, ' + s.ms + 'ms)' : 'error — ' + s.error));
        return { content: lines.join('\n') || 'هیچ سروری تنظیم نشده / no servers configured', added: r.added, removed: r.removed };
      }),
    t('mcp_connect',
      'Connect a NEW MCP (Model Context Protocol) server so its tools become available as mcp_<server>_<tool>. ADMIN ONLY — and the owner must approve via the permission card that appears. url: the server\'s Streamable HTTP endpoint (usually ends with /mcp). name: optional short label. apiKey: only if the server requires a static key. For OAuth (login) servers, do NOT pass apiKey — the tool returns a login link for the user instead.',
      {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'https://…/mcp — the Streamable HTTP endpoint' },
          name: { type: 'string', description: 'Optional short server label (a-z, 0-9)' },
          apiKey: { type: 'string', description: 'Static API key, only for servers that require one (NOT for OAuth servers)' },
        },
        required: ['url'],
      },
      async (ctx, args) => {
        if (envStr('JINX_MCP_ALLOW_CONNECT', '1') === '0') {
          return { error: 'اتصال خودکار توسط مالک غیرفعال شده (JINX_MCP_ALLOW_CONNECT=0) — سرورها را از portable/mcp.json اضافه کنید.' };
        }
        if (!ctx || !ctx.admin) {
          return { error: 'فقط مالک ربات (admin) می‌تواند سرور MCP جدید وصل کند. / Only the bot owner can connect new MCP servers.' };
        }
        const url = String(args.url || '').trim();
        if (!/^https?:\/\//i.test(url)) return { error: 'url باید با http:// یا https:// شروع شود' };

        // already connected?
        const existing = state.servers.find((s) => s.url === url);
        if (existing) {
          const r = await connectNow(url); // re-discover; refreshes tokens
          if (r.ok) return r;
          // fall through to a fresh attempt below (e.g. token expired and OAuth needed again)
        }

        // 🔐 the human permission gate — fires the approval card, blocks until decided
        const denied = await requestPermission(ctx, url, args.name);
        if (denied) return denied;

        // preflight: no auth / API key / OAuth?
        const o = oauth();
        if (o) {
          const disc = await o.discover(url);
          if (disc.error) return { error: 'سرور در دسترس نیست — ' + disc.error + ' (آدرس و در دسترس بودن endpoint را چک کن)' };
          if (disc.needsAuth && !disc.apiKeyOnly) {
            const r = await o.start(url, { name: args.name });
            if (r.error || r.needsApiKey) return r;
            if (r.authorizeUrl) {
              return {
                authorizeUrl: r.authorizeUrl,
                content: '🔐 این سرور لاگین (OAuth) می‌خواهد. این لینک را «دقیقاً همان‌طور که هست» برای کاربر بفرست و بگو در مرورگر بازش کند، لاگین کند و اجازه بدهد:\n\n' + r.authorizeUrl +
                  '\n\nبعد از تأیید، اتصال خودکار کامل می‌شود (توکن ذخیره و ابزارها ثبت می‌شوند). اگر مرورگر به صفحهٔ بازگشت نرسید، از کاربر بخواه آدرس نهایی را از نوار آدرس کپی کند و همین‌جا بفرستد — بعد mcp_oauth_complete را صدا بزن. مهلت: ' + (r.expiresInMin || 15) + ' دقیقه.',
              };
            }
          }
          if (disc.needsAuth && disc.apiKeyOnly && !args.apiKey) {
            return {
              needsApiKey: true,
              content: '🔑 این سرور کلید/API key می‌خواهد و OAuth استاندارد منتشر نمی‌کند. از کاربر (مالک) بپرس کلیدش را بدهد؛ بعد mcp_connect را با پارامتر apiKey دوباره صدا بزن. اگر سرور هدر اختصاصی می‌خواهد، راهنمایی‌اش docs/MCP.md است.',
            };
          }
        }

        // plain connect (no auth, or static apiKey, or token already stored)
        const auth = args.apiKey ? 'Bearer ' + String(args.apiKey) : undefined;
        let r = await connectNow(url, { name: args.name, auth });
        if (!r.ok && args.apiKey && /authentication rejected \(HTTP 40[13]\)/i.test(String(r.error || ''))) {
          // some servers want a custom header instead of Authorization
          r = await connectNow(url, { name: args.name, headers: { 'X-Api-Key': String(args.apiKey) } });
        }
        return r;
      }),
    t('mcp_disconnect',
      'Disconnect an MCP server that was connected via mcp_connect (agent-connected only; owner-configured servers are edited in mcp.json). ADMIN ONLY.',
      { type: 'object', properties: { name: { type: 'string', description: 'Server name as shown by mcp_servers' } }, required: ['name'] },
      async (ctx, args) => {
        if (!ctx || !ctx.admin) return { error: 'فقط مالک ربات می‌تواند سرور MCP را قطع کند. / Owner only.' };
        return disconnectServer(String(args.name || ''));
      }),
    t('mcp_oauth_complete',
      'Complete an MCP OAuth login from a URL the user pasted into the chat (the final redirected URL containing code & state, e.g. https://…/oauth/mcp/callback?code=…&state=…). Call this when the user sends such a URL after an MCP login. ADMIN ONLY.',
      { type: 'object', properties: { url_or_code: { type: 'string', description: 'The pasted URL (or "code state" pair)' } }, required: ['url_or_code'] },
      async (ctx, args) => {
        if (!ctx || !ctx.admin) return { error: 'فقط مالک ربات. / Owner only.' };
        const o = oauth();
        if (!o) return { error: 'ماژول OAuth موجود نیست (mcp-oauth.cjs)' };
        const parsed = o.parseManual(args.url_or_code);
        if (!parsed || !parsed.state) {
          return { error: 'آدرس کپی‌شده کد/state ندارد — از کاربر بخواه «آدرس کامل» نهایی مرورگر را بعد از لاگین کپی کند.' };
        }
        const r = await o.completeWithState(parsed.state, parsed.code);
        if (!r.ok) return { error: r.error };
        return { ok: true, server: r.server, content: '✅ لاگین ' + r.server + ' کامل شد و ابزارهایش ثبت شد. برای فهرست: mcp_servers.' };
      }),
  ];
}

// ── install (called from the patched bundle, inside init_tools) ────────────
function install(api) {
  if (state.installed) return;
  if (!api || !Array.isArray(api.ALL_TOOLS) || !(api.BY_NAME instanceof Map)) {
    throw new Error('install({ALL_TOOLS, BY_NAME}) — engine registries missing');
  }
  state.installed = true;
  state.ALL_TOOLS = api.ALL_TOOLS;
  state.BY_NAME = api.BY_NAME;
  state.sec = (api.sec && typeof api.sec.requestApproval === 'function') ? api.sec : null;
  state.servers = loadConfig();

  for (const t of metaTools()) {
    state.ALL_TOOLS.push(t);
    state.BY_NAME.set(t.meta.name, t);
  }

  if (!state.servers.length) {
    log('ready — no servers configured (mcp_connect • JINX_MCP_SERVERS • docs/MCP.md)');
    return;
  }

  const hadCache = loadRegistryCache();
  const r = syncTools();
  log('ready — ' + state.servers.length + ' server(s): ' + state.servers.map((s) => s.name).join(', ') +
      (hadCache ? ' • ' + r.added + ' cached tool(s) registered' : ' • discovering in background…') +
      (state.sec ? ' • self-connect: ON' : ' • self-connect: legacy hook (no permission gate)'));

  const fresh = hadCache && state.servers.every((s) => {
    const live = state.live.get(s.name);
    return live && live.checkedAt && Date.now() - live.checkedAt < REGISTRY_TTL_MS;
  });
  if (!fresh) {
    refresh().then((r2) => {
      for (const s of r2.servers) {
        log('  ' + s.name + ': ' + (s.ok ? s.tools + ' tool(s) ✓ (' + s.ms + 'ms)' : '✗ ' + s.error));
      }
    });
  }
}

module.exports = {
  install, refresh, discover, connectNow, disconnectServer,
  _internal: {
    state, loadConfig, parseEnvServers, normalizeSchema, sseMessages, toolRecord, syncTools,
    loadRegistryCache, saveRegistry, rpc, readRpc, metaTools, requestPermission, saveDynamic, loadDynamic,
  },
};
