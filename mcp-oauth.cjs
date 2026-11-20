// ═══════════════════════════════════════════════════════════════════════════
//  Jinx Harness v2 — MCP OAuth module  ("login-required MCP servers")
//
//  Full MCP authorization (spec 2025-06-18) for servers like Higgsfield,
//  Runway, HeyGen or anything behind an OAuth login:
//    1. 401 on initialize + WWW-Authenticate → protected-resource metadata
//    2. authorization-server metadata (/.well-known/oauth-authorization-server)
//    3. OAuth 2.0 Dynamic Client Registration (RFC 7591)
//    4. Authorization-code flow with PKCE (S256) — public client, no secret
//    5. callback served by the agent itself at  /oauth/mcp/callback
//       (reachable through index.cgi / jadmin.cgi on shared hosting)
//    6. token storage + automatic refresh on expiry
//
//  Manual fallback: if the browser cannot reach the callback, the user copies
//  the final URL from the address bar and pastes it into the chat — the agent
//  finishes the exchange with mcp_oauth_complete.
//
//  Zero dependencies, pure Node 18+. Tokens live in
//  portable/data/mcp-tokens.json (chmod 600 best-effort) and are NEVER logged.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'portable', 'data');
function envPath(k, d) { const v = process.env[k]; return v && String(v).trim() ? path.resolve(String(v).trim()) : d; }
const PENDING_FILE = envPath('JINX_MCP_OAUTH_PENDING', path.join(DATA_DIR, 'mcp-oauth-pending.json'));
const TOKENS_FILE = envPath('JINX_MCP_TOKENS', path.join(DATA_DIR, 'mcp-tokens.json'));
const FLOW_TTL_MS = 15 * 60_000;
const USER_AGENT = 'jinx-harness/2.1.0 (MCP OAuth; +https://github.com/SirBNL/jinx-harness)';

function log(line) { try { console.log('[jinx-mcp-oauth] ' + line); } catch { /* CGI */ } }
function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }

// ── tiny json-file store ────────────────────────────────────────────────────
function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}
function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    try { fs.chmodSync(file, 0o600); } catch { /* shared hosts */ }
    return true;
  } catch (e) { log('cannot write ' + path.basename(file) + ': ' + clip(e && e.message, 120)); return false; }
}
function cleanPending() {
  const list = readJson(PENDING_FILE, []);
  const now = Date.now();
  const kept = (Array.isArray(list) ? list : []).filter((f) => f && f.createdAt && now - f.createdAt < FLOW_TTL_MS);
  if (kept.length !== (Array.isArray(list) ? list : []).length) writeJson(PENDING_FILE, kept);
  return kept;
}
function savePending(flow) {
  const list = cleanPending().filter((f) => f.serverUrl !== flow.serverUrl);
  list.push(flow);
  writeJson(PENDING_FILE, list);
}
function popPending(state) {
  const list = cleanPending();
  const i = list.findIndex((f) => f.state === String(state || ''));
  if (i < 0) return null;
  const [flow] = list.splice(i, 1);
  writeJson(PENDING_FILE, list);
  return flow;
}

// ── helpers ─────────────────────────────────────────────────────────────────
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function publicBaseUrl() {
  const u = String(process.env.JINX_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(u) ? u : null;
}
function redirectUri() { const b = publicBaseUrl(); return b ? b + '/oauth/mcp/callback' : null; }

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT, ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeoutMs || 12_000) });
  const txt = await res.text();
  if (!res.ok) { const e = new Error('HTTP ' + res.status + (txt ? ': ' + clip(txt, 140) : '')); e.status = res.status; throw e; }
  try { return JSON.parse(txt); } catch { throw new Error('non-JSON response from ' + clip(url, 80)); }
}

/** Parse WWW-Authenticate for resource metadata URI (spec 2025-06-18). */
function resourceMetadataFromHeader(h) {
  const s = String(h || '');
  let m = s.match(/resource_metadata_uri\s*=\s*"([^"]+)"/i);
  if (m) return m[1];
  m = s.match(/resource\s*=\s*"([^"]+)"/i);
  if (m) return m[1];
  return null;
}

/** Well-known candidates for protected-resource metadata, per spec. */
function resourceMetadataCandidates(serverUrl) {
  const u = new URL(serverUrl);
  const out = [];
  // 1) path-based: replace the last path segment
  const p = u.pathname.replace(/\/[^/]*$/, '');
  out.push(new URL(u.origin + p + '/.well-known/oauth-protected-resource').toString());
  // 2) origin-based
  out.push(u.origin + '/.well-known/oauth-protected-resource');
  return [...new Set(out)];
}

// ── discovery: does this server need OAuth, and where is its AS? ───────────
async function discover(serverUrl) {
  // probe with an initialize that carries no credentials
  try {
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jinx-harness', version: '2.1.0' } } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 401 && res.status !== 403) {
      return { needsAuth: false, status: res.status };
    }
    const wwwAuth = res.headers.get('www-authenticate') || '';
    const fromHeader = resourceMetadataFromHeader(wwwAuth);
    const candidates = fromHeader ? [fromHeader, ...resourceMetadataCandidates(serverUrl)] : resourceMetadataCandidates(serverUrl);
    for (const metaUrl of candidates) {
      try {
        const meta = await fetchJson(metaUrl);
        const servers = Array.isArray(meta.authorization_servers) ? meta.authorization_servers.filter(Boolean) : [];
        if (!servers.length) continue;
        return { needsAuth: true, authorizationServer: servers[0], resource: (typeof meta.resource === 'string' && meta.resource) || undefined };
      } catch { /* try next candidate */ }
    }
    // 401 but no discoverable OAuth metadata → probably a static API-key server
    return { needsAuth: true, apiKeyOnly: true, status: res.status, wwwAuth: clip(wwwAuth, 120) };
  } catch (e) {
    return { error: clip(e && e.message, 200) };
  }
}

// ── start a flow ────────────────────────────────────────────────────────────
async function start(serverUrl, opts = {}) {
  const name = String(opts.name || '').slice(0, 24);
  const disc = await discover(serverUrl);
  if (disc.error) return { error: 'اتصال به سرور برقرار نشد / server unreachable — ' + disc.error };
  if (!disc.needsAuth) return { needsAuth: false };
  if (disc.apiKeyOnly) {
    return {
      needsApiKey: true,
      note: 'این سرور OAuth استاندارد MCP را منتشر نمی‌کند — احتمالاً به API key یا هدر اختصاصی نیاز دارد. ' +
        'اگر کلید داری، mcp_connect را با پارامتر apiKey صدا بزن؛ برای هدرهای اختصاصی portable/mcp.json (docs/MCP.md).',
    };
  }

  const ru = redirectUri();
  if (!ru) {
    return {
      error: 'برای OAuth باید JINX_PUBLIC_URL تنظیم باشد',
      hint: 'JINX_PUBLIC_URL را در portable/.env روی آدرس عمومی CGI دیمن بگذار (مثلاً https://host/cgi-bin/index.cgi یا https://host/cgi-bin/jadmin.cgi) و ری‌استارت کن — سپس دوباره امتحان کن.',
    };
  }

  // AS metadata
  let as;
  try {
    as = await fetchJson(String(disc.authorizationServer).replace(/\/+$/, '') + '/.well-known/oauth-authorization-server');
  } catch (e) {
    return { error: 'متادیتای سرور احراز هویت خوانده نشد / authorization-server metadata unreadable — ' + clip(e && e.message, 160) };
  }
  const authEndpoint = as.authorization_endpoint, tokenEndpoint = as.token_endpoint;
  if (!authEndpoint || !tokenEndpoint) {
    return { error: 'سرور احراز هویت endpoints لازم را معرفی نکرده (authorization_endpoint/token_endpoint)' };
  }

  // Dynamic Client Registration (RFC 7591) — try advertised, then /register
  const regUrls = [...new Set([as.registration_endpoint, String(disc.authorizationServer).replace(/\/+$/, '') + '/register'].filter(Boolean))];
  let clientId = null, clientSecret = null, dcr = false;
  for (const reg of regUrls) {
    try {
      const r = await fetchJson(reg, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Jinx Harness (' + (name || new URL(serverUrl).hostname) + ')',
          redirect_uris: [ru],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          client_uri: 'https://github.com/SirBNL/jinx-harness',
        }),
      });
      if (r && r.client_id) { clientId = r.client_id; clientSecret = r.client_secret || null; dcr = true; break; }
    } catch { /* try next */ }
  }
  if (!clientId) {
    return {
      error: 'این سرور ثبت‌نام پویا (Dynamic Client Registration) را نمی‌پذیرد',
      hint: 'این MCP با کلاینت‌های از پیش ثبت‌شده کار می‌کند. اگر client_id/secret داری، در portable/mcp.json با فیلد auth وارد کن؛ وگرنه از نسخه‌ی API-key همین سرور استفاده کن.',
    };
  }

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = crypto.randomBytes(16).toString('hex');
  const scopes = Array.isArray(as.scopes_supported) && as.scopes_supported.length ? as.scopes_supported.join(' ') : null;

  const u = new URL(authEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', ru);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (scopes) u.searchParams.set('scope', scopes);
  if (disc.resource) u.searchParams.set('resource', disc.resource);

  savePending({
    state, serverUrl, name: name || new URL(serverUrl).hostname,
    verifier, clientId, clientSecret, dcr,
    authEndpoint, tokenEndpoint, redirectUri: ru,
    scopes: scopes || undefined, resource: disc.resource || undefined,
    createdAt: Date.now(),
  });

  log('flow started: ' + (name || serverUrl) + ' → ' + clip(u.toString(), 100));
  return {
    authorizeUrl: u.toString(),
    expiresInMin: Math.round(FLOW_TTL_MS / 60_000),
    note: 'لینک را برای کاربر بفرست تا در مرورگرش باز شود، لاگین کند و اجازه بدهد. بعد از تأیید، اتصال خودکار کامل می‌شود؛ اگر صفحه‌ی بازگشت باز نشد، کاربر آدرس نهایی را از نوار آدرس کپی می‌کند و همین‌جا می‌فرستد.',
  };
}

// ── token exchange ──────────────────────────────────────────────────────────
async function exchangeCode(flow, code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(code),
    redirect_uri: flow.redirectUri,
    client_id: flow.clientId,
    code_verifier: flow.verifier,
  });
  if (flow.clientSecret) body.set('client_secret', flow.clientSecret);
  const tok = await fetchJson(flow.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!tok.access_token) throw new Error('token endpoint returned no access_token');
  return tok;
}

function saveToken(serverUrl, flow, tok) {
  const all = readJson(TOKENS_FILE, {});
  all[serverUrl] = {
    accessToken: String(tok.access_token),
    refreshToken: tok.refresh_token ? String(tok.refresh_token) : undefined,
    expiresAt: Number(tok.expires_in) > 0 ? Date.now() + Number(tok.expires_in) * 1000 : undefined,
    scope: tok.scope || flow.scopes || undefined,
    tokenType: tok.token_type || 'Bearer',
    clientId: flow.clientId,
    clientSecret: flow.clientSecret || undefined,
    tokenEndpoint: flow.tokenEndpoint,
    serverName: flow.name || undefined,
    obtainedAt: Date.now(),
  };
  writeJson(TOKENS_FILE, all);
  log('token saved for ' + (flow.name || serverUrl));
  // hot-connect through the bridge (lazy require — no cycle at load time).
  // Fire-and-forget here; completeWithState() awaits its own deterministic
  // connectNow so the model sees the final tool count in the tool result.
  try {
    const bridge = require('./mcp-bridge.cjs');
    if (typeof bridge.connectNow === 'function') {
      bridge.connectNow(serverUrl, { name: flow.name }).catch((e) =>
        log('hot-connect failed: ' + clip(e && e.message, 140)));
    }
  } catch { /* bridge not loaded — tools sync on next refresh */ }
}

/** Exchange + save; used by both the HTTP callback and manual paste. */
async function completeWithState(state, code) {
  const flow = popPending(state);
  if (!flow) return { ok: false, error: 'چنین درخواست OAuth فعالی نیست (منقضی یا ناشناخته) — دوباره mcp_connect را صدا بزن.' };
  try {
    const tok = await exchangeCode(flow, code);
    saveToken(flow.serverUrl, flow, tok);
    let tools = null;
    try {
      const bridge = require('./mcp-bridge.cjs');
      if (typeof bridge.connectNow === 'function') {
        const c = await bridge.connectNow(flow.serverUrl, { name: flow.name });
        tools = c && c.ok ? c.tools : null;
      }
    } catch { /* bridge absent — fine */ }
    return { ok: true, server: flow.name || flow.serverUrl, url: flow.serverUrl, tools };
  } catch (e) {
    return { ok: false, error: 'تبدیل کد به توکن ناموفق بود — ' + clip(e && e.message, 200) };
  }
}

/** Manual paste path: user copies the redirected URL (or code+state) into chat. */
function parseManual(text) {
  const s = String(text || '');
  let code = null, state = null;
  const mUrl = s.match(/https?:\/\/\S+/g) || [];
  for (const raw of mUrl) {
    try {
      const u = new URL(raw.replace(/[)\]}>,»"]+$/, ''));
      if (u.searchParams.get('code')) { code = u.searchParams.get('code'); state = u.searchParams.get('state') || state; }
    } catch { /* keep scanning */ }
  }
  if (!code) {
    const m2 = s.match(/\b([0-9a-f]{24,64})\b[\s,/:]+([0-9a-f]{24,64})\b/i); // "code state"
    if (m2) { code = m2[1]; state = m2[2]; }
  }
  return code ? { code, state } : null;
}

// ── auth for outgoing MCP requests (with refresh) ──────────────────────────
async function authHeaderFor(serverUrl, opts = {}) {
  const all = readJson(TOKENS_FILE, {});
  const t = all[serverUrl];
  if (!t || !t.accessToken) return null;
  const expiring = t.expiresAt && t.expiresAt - 60_000 < Date.now();
  if (!expiring && !opts.force) return (t.tokenType || 'Bearer') + ' ' + t.accessToken;
  if (!t.refreshToken) return (t.tokenType || 'Bearer') + ' ' + t.accessToken; // let it fail naturally
  try {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: t.clientId });
    if (t.clientSecret) body.set('client_secret', t.clientSecret);
    const tok = await fetchJson(t.tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (!tok.access_token) throw new Error('no access_token in refresh response');
    saveToken(serverUrl, { name: t.serverName, clientId: t.clientId, clientSecret: t.clientSecret, tokenEndpoint: t.tokenEndpoint, scopes: t.scope }, tok);
    return (tok.token_type || 'Bearer') + ' ' + tok.access_token;
  } catch (e) {
    log('refresh failed for ' + clip(serverUrl, 60) + ': ' + clip(e && e.message, 120));
    return (t.tokenType || 'Bearer') + ' ' + t.accessToken; // last known token; server will 401 if truly dead
  }
}

function tokenStatus() {
  const all = readJson(TOKENS_FILE, {});
  return Object.entries(all).map(([url, t]) => ({
    url, name: t.serverName || undefined,
    ok: !!t.accessToken,
    expiresAt: t.expiresAt || undefined,
    canRefresh: !!t.refreshToken,
  }));
}

// ── HTTP surface (served by the daemon at /oauth/mcp/*) ────────────────────
// NOTE: responses are PLAIN TEXT on purpose — cPanel's upload WAF strips
// HTML charset declarations (even split or inside comments!) out of uploaded
// files, which once broke byte-exact verification. No tags → nothing to strip.
function page(title, body, ok) {
  return (ok ? '✅ ' : '⚠️ ') + title + '\n\n' + body + '\n\n— Jinx Harness';
}

async function http(env, req, res, u, p) {
  if (p === '/oauth/mcp/status') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ pending: cleanPending().map((f) => ({ name: f.name, url: f.serverUrl, startedAt: f.createdAt, expiresInMin: Math.max(0, Math.round((f.createdAt + FLOW_TTL_MS - Date.now()) / 60_000)) })), tokens: tokenStatus() }));
    return;
  }
  if (p !== '/oauth/mcp/callback') {
    res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('not found'); return;
  }
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  const err = u.searchParams.get('error');
  if (err) {
    res.statusCode = 200; res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(page('اتصال رد شد', 'سرور احراز هویت اجازه نداد: ' + String(err).slice(0, 120) + ' — می‌توانی دوباره از ربات درخواست اتصال بکنی.', false));
    return;
  }
  if (!code || !state) {
    res.statusCode = 400; res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(page('پاسخ ناقص', 'این آدرس فقط برای بازگشت جریان OAuth سرورهای MCP است.', false));
    return;
  }
  const r = await completeWithState(state, code);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (r.ok) {
    res.end(page('اتصال برقرار شد ✓', 'سرور ' + String(r.server).slice(0, 60) + ' متصل شد. به تلگرام برگرد و از ایجنت بخواه ابزارها را فهرست کند (mcp_servers).', true));
  } else {
    res.end(page('اتصال کامل نشد', String(r.error).slice(0, 300), false));
  }
}

module.exports = { discover, start, http, completeWithState, parseManual, authHeaderFor, tokenStatus, _files: { PENDING_FILE, TOKENS_FILE } };
