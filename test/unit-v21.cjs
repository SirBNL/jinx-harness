#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  Jinx Harness v2.1 — unit tests (self-connect, permission gate, OAuth)
//
//  Runs fully offline against local mocks:
//    A. repairToolHistory — the engine-level fix for the tool-history 400 loop
//       (extracted verbatim from the patched dist/portable.cjs)
//    B. mcp_connect permission gate (non-admin / denied / approved)
//    C. API-key servers (needsApiKey → Bearer → X-Api-Key fallback)
//    D. full OAuth flow against a mock authorization server:
//       discover → DCR → PKCE authorize URL → code exchange → token saved →
//       hot-connect → authenticated tool call
//    E. OAuth HTTP callback handler + manual paste parsing
//    F. disconnect + dynamic-store persistence + redaction
//
//  Usage: node test/unit-v21.cjs
// ═══════════════════════════════════════════════════════════════════════════
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const results = [];
let failed = 0;
function T(name, ok, detail) {
  results.push([ok ? '✓' : '✗', name, detail ? String(detail).slice(0, 300) : '']);
  if (!ok) failed++;
}
function eq(a, b, name) { T(name, JSON.stringify(a) === JSON.stringify(b), a + ' vs ' + b); }

// hermetic paths
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jinx-v21-'));
process.env.JINX_MCP_JSON = path.join(TMP, 'no-mcp.json');
process.env.JINX_MCP_REGISTRY = path.join(TMP, 'registry.json');
process.env.JINX_MCP_DYNAMIC = path.join(TMP, 'dynamic.json');
process.env.JINX_MCP_TOKENS = path.join(TMP, 'tokens.json');
process.env.JINX_MCP_OAUTH_PENDING = path.join(TMP, 'pending.json');
process.env.JINX_PUBLIC_URL = 'http://127.0.0.1:59999'; // dummy public base (DCR mock accepts it)
delete process.env.JINX_MCP_SERVERS;
delete process.env.JINX_MCP_OFF;

const bridge = require(path.join(ROOT, 'mcp-bridge.cjs'));
const oauth = require(path.join(ROOT, 'mcp-oauth.cjs'));
const { state, saveDynamic, loadDynamic } = bridge._internal;

// ── spawn helper (same protocol as unit-bridge) ─────────────────────────────
function startMock(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'test', 'mock-mcp-server.cjs')], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    const onLine = (line) => {
      line = line.trim();
      if (!line) return;
      try { const j = JSON.parse(line); if (j.port) resolve({ child, port: j.port }); } catch { /* */ }
    };
    child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on('data', (c) => console.error('  [mock:err]', String(c).trim().slice(0, 160)));
  });
}
function ctrl(mock, obj) {
  return new Promise((resolve) => {
    let buf = '';
    const h = (c) => {
      buf += c; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        if (l.trim()) { mock.child.stdout.removeListener('data', h); try { resolve(JSON.parse(l.trim())); } catch { resolve(null); } return; }
      }
    };
    mock.child.stdout.on('data', h);
    mock.child.stdin.write(JSON.stringify(obj) + '\n');
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshRegistries() {
  const ALL_TOOLS = [{ meta: { name: 'web_search', group: 'web_search', spec: { type: 'function', function: { name: 'web_search', description: 'built-in', parameters: { type: 'object', properties: {} } } } }, handler: async () => ({}) }];
  const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.meta.name, t]));
  return { ALL_TOOLS, BY_NAME };
}
function resetBridge(sec) {
  state.installed = false; state.servers = []; state.live.clear();
  state.ALL_TOOLS = null; state.BY_NAME = null; state.refreshing = null; state.sec = sec || null;
}
const adminCtx = { admin: true, chat: { id: 70001, type: 'private' }, user: { id: 70001 }, env: {}, state: {} };
const guestCtx = { admin: false, chat: { id: 8, type: 'private' }, user: { id: 8 }, env: {}, state: {} };

// ═════════════════════════════════════════════════════════════════════════
(async () => {
  console.log('\n🧪 Jinx v2.1 — unit tests (connect / permission / OAuth)\n' + '─'.repeat(52));

  // ── A. repairToolHistory (extracted from the patched bundle) ──────────────
  {
    const bundle = fs.readFileSync(path.join(ROOT, 'dist', 'portable.cjs'), 'utf8');
    const m = bundle.match(/var repairToolHistory = function \(list\) \{[\s\S]*?\n\};/);
    T('A: repairToolHistory present in patched bundle', !!m, m ? '' : 'not found — was patch_engine_v21.py run?');
    if (m) {
      const repair = eval('(' + m[0].replace(/^var repairToolHistory = /, '').replace(/;$/, '') + ')');
      eq(repair([{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }]).length, 2, 'A: clean history untouched');
      eq(repair([{ role: 'system', content: 's' }, { role: 'tool', tool_call_id: 'x1', content: 'orphan' }, { role: 'user', content: 'hi' }]).length, 2, 'A: leading orphan tool dropped');
      const fixed = repair([
        { role: 'system', content: 's' }, { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 't', arguments: '{}' } }, { id: 'c2', function: { name: 'u', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '' },
        { role: 'assistant', content: 'done' },
      ]);
      eq(fixed.filter((x) => x.role === 'tool').length, 2, 'A: missing result synthesized');
      eq(fixed.find((x) => x.tool_call_id === 'c2').content, '(result unavailable)', 'A: synthesized placeholder text');
      eq(fixed.find((x) => x.tool_call_id === 'c1').content, '(no output)', 'A: empty tool content filled');
      eq(repair([{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 't', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'a' }, { role: 'tool', tool_call_id: 'c1', content: 'dup' }]).filter((x) => x.role === 'tool').length, 1, 'A: duplicate tool result deduped');
    }
  }

  // ── B. permission gate ────────────────────────────────────────────────────
  const mockPlain = await startMock({});
  try {
    let decisions = [];
    const sec = { requestApproval: async (_ctx, name, args) => {
      if (name !== 'mcp_connect') throw new Error('unexpected approval tool: ' + name);
      if (!/^https?:\/\//.test(args.url || '')) throw new Error('approval args missing url');
      return decisions.length ? decisions.shift() : null; // default: approve
    } };
    resetBridge(sec);
    const reg = freshRegistries();
    bridge.install({ ...reg, sec });
    const connect = reg.BY_NAME.get('mcp_connect');
    T('B: meta tools registered (5)', ['mcp_servers', 'mcp_refresh', 'mcp_connect', 'mcp_disconnect', 'mcp_oauth_complete'].every((n) => reg.BY_NAME.has(n)), [...reg.BY_NAME.keys()].filter((k) => k.startsWith('mcp_')).join(','));

    const u = 'http://127.0.0.1:' + mockPlain.port + '/mcp';
    const rGuest = await connect.handler(guestCtx, { url: u });
    T('B: non-admin refused', rGuest && /فقط مالک|Owner only|admin/i.test(rGuest.error || ''), JSON.stringify(rGuest).slice(0, 120));

    decisions.push({ ok: false, error: 'The user DENIED this action via the security approval.' });
    const rDenied = await connect.handler(adminCtx, { url: u, name: 'plain' });
    T('B: denied by human → no connect', rDenied && /مجاز نشد|DENIED/i.test(rDenied.error || ''), JSON.stringify(rDenied).slice(0, 160));
    T('B: nothing registered after deny', !state.servers.some((s) => s.url === u), '');

    const rOk = await connect.handler(adminCtx, { url: u, name: 'plain' });
    T('B: approved → connected', rOk && rOk.ok === true && rOk.tools === 4, JSON.stringify(rOk).slice(0, 160));
    T('B: tools live in registry', reg.BY_NAME.has('mcp_plain_add'), [...reg.BY_NAME.keys()].filter((k) => k.startsWith('mcp_plain')).join(','));
    const dyn = loadDynamic();
    T('B: dynamic store persisted', dyn.length === 1 && dyn[0].name === 'plain' && dyn[0].source === 'agent', JSON.stringify(dyn.map((s) => s.name)));
    const sum = await reg.BY_NAME.get('mcp_plain_add').handler({}, { a: 6, b: 7 });
    eq(sum.content, '13', 'B: connected server tool callable');

    // disconnect
    const dOut = await reg.BY_NAME.get('mcp_disconnect').handler(adminCtx, { name: 'plain' });
    T('F: disconnect removes tools', dOut && dOut.ok === true && !reg.BY_NAME.has('mcp_plain_add'), JSON.stringify(dOut).slice(0, 120));
    eq(loadDynamic().length, 0, 'F: dynamic store emptied');
    // static servers refuse disconnect
    process.env.JINX_MCP_SERVERS = 'stat=' + u;
    resetBridge(sec);
    const reg2 = freshRegistries();
    bridge.install({ ...reg2, sec });
    const dStat = await reg2.BY_NAME.get('mcp_disconnect').handler(adminCtx, { name: 'stat' });
    T('F: owner-configured server refuses disconnect', dStat && /mcp\.json|مالک/.test(dStat.error || ''), JSON.stringify(dStat).slice(0, 140));
    delete process.env.JINX_MCP_SERVERS;
  } finally {
    await ctrl(mockPlain, { op: 'exit' }).catch(() => {});
    mockPlain.child.kill();
  }

  // ── C. API-key server ─────────────────────────────────────────────────────
  const mockKey = await startMock({ MOCK_MCP_AUTH: 'Bearer key123' });
  try {
    resetBridge({ requestApproval: async () => null });
    const reg = freshRegistries();
    bridge.install({ ...reg, sec: { requestApproval: async () => null } });
    const connect = reg.BY_NAME.get('mcp_connect');
    const u = 'http://127.0.0.1:' + mockKey.port + '/mcp';

    const rNoKey = await connect.handler(adminCtx, { url: u, name: 'keyed' });
    T('C: key-required server → needsApiKey', rNoKey && (rNoKey.needsApiKey === true || rNoKey.error), JSON.stringify(rNoKey).slice(0, 160));

    const rKey = await connect.handler(adminCtx, { url: u, name: 'keyed', apiKey: 'key123' });
    T('C: apiKey → connected via Authorization', rKey && rKey.ok === true && rKey.tools === 4, JSON.stringify(rKey).slice(0, 160));
    const redact = JSON.stringify(state.servers.find((s) => s.name === 'keyed'));
    T('C: key stored in dynamic config (not logged)', redact.includes('Bearer key123') === true, 'dynamic entry keeps auth for future runs');
    saveDynamic();
    const dynRaw = fs.readFileSync(process.env.JINX_MCP_DYNAMIC, 'utf8');
    T('C: dynamic file chmod-able and valid JSON', !!JSON.parse(dynRaw), '');
  } finally {
    await ctrl(mockKey, { op: 'exit' }).catch(() => {});
    mockKey.child.kill();
  }

  // ── D. OAuth server (full flow) ───────────────────────────────────────────
  const mockOauth = await startMock({ MOCK_MCP_OAUTH: '1' });
  try {
    resetBridge({ requestApproval: async () => null });
    const reg = freshRegistries();
    bridge.install({ ...reg, sec: { requestApproval: async () => null } });
    const connect = reg.BY_NAME.get('mcp_connect');
    const complete = reg.BY_NAME.get('mcp_oauth_complete');
    const u = 'http://127.0.0.1:' + mockOauth.port + '/mcp';

    // D1: connect → authorizeUrl (not connected yet)
    const r1 = await connect.handler(adminCtx, { url: u, name: 'mockai' });
    T('D: OAuth server returns authorizeUrl', r1 && !!r1.authorizeUrl, JSON.stringify(r1).slice(0, 200));
    T('D: pending flow stored', JSON.parse(fs.readFileSync(process.env.JINX_MCP_OAUTH_PENDING, 'utf8')).length === 1, '');
    const authUrl = new URL(r1.authorizeUrl);
    T('D: PKCE S256 in authorize URL', authUrl.searchParams.get('code_challenge_method') === 'S256' && !!authUrl.searchParams.get('code_challenge'), '');
    T('D: state + redirect_uri present', !!authUrl.searchParams.get('state') && authUrl.searchParams.get('redirect_uri') === 'http://127.0.0.1:59999/oauth/mcp/callback', authUrl.searchParams.get('redirect_uri'));
    T('D: scopes advertised by AS requested', authUrl.searchParams.get('scope') === 'mcp:read mcp:write', authUrl.searchParams.get('scope'));

    // D2: simulate the browser: open authorize URL → 302 to callback
    const br = await fetch(r1.authorizeUrl, { redirect: 'manual' });
    T('D: authorize endpoint 302s', br.status === 302 || br.status === 301, 'status=' + br.status);
    const loc = br.headers.get('location') || '';
    T('D: redirect carries code+state', /oauth\/mcp\/callback\?code=/.test(loc), loc.slice(0, 120));

    // D3: manual paste path — user pastes the final URL into the chat
    const parsed = oauth.parseManual('لاگین کردم! آدرس نهایی: ' + loc);
    T('E: parseManual extracts code+state from pasted URL', parsed && !!parsed.code && !!parsed.state, JSON.stringify(parsed));
    const rComplete = await complete.handler(adminCtx, { url_or_code: loc });
    T('D: mcp_oauth_complete → connected', rComplete && rComplete.ok === true && /mockai/.test(rComplete.server || ''), JSON.stringify(rComplete).slice(0, 200));
    T('D: token file saved', fs.existsSync(process.env.JINX_MCP_TOKENS), '');
    const tok = JSON.parse(fs.readFileSync(process.env.JINX_MCP_TOKENS, 'utf8'));
    T('D: token has refresh + expiry', tok[u] && tok[u].refreshToken && tok[u].expiresAt > Date.now(), '');
    T('D: tools registered after hot-connect', reg.BY_NAME.has('mcp_mockai_add'), [...reg.BY_NAME.keys()].filter((k) => k.startsWith('mcp_mockai')).join(','));
    const addOut = await reg.BY_NAME.get('mcp_mockai_add').handler({}, { a: 20, b: 22 });
    eq(addOut.content, '42', 'D: authenticated tool call works');
    const st = await ctrl(mockOauth, { op: 'stats' });
    T('D: AS saw register+authorize+token', st && st.oauth.register >= 1 && st.oauth.authorize >= 1 && st.oauth.token >= 1 && st.oauth.rejected === 0, JSON.stringify(st && st.oauth));

    // D4: HTTP callback handler (fresh flow, this time through http())
    const r2 = await connect.handler(adminCtx, { url: u, name: 'mockai' }); // already connected → re-discover? no OAuth needed now (token present)
    T('D: reconnect with stored token skips OAuth', r2 && r2.ok === true && !r2.authorizeUrl, JSON.stringify(r2).slice(0, 160));

    // callback handler error branches
    const fakeRes = () => {
      const r = { statusCode: 0, headers: {}, body: '' };
      r.setHeader = (k, v) => { r.headers[k] = v; };
      r.end = (x) => { r.body = String(x == null ? '' : x); r.done = true; };
      return r;
    };
    const res400 = fakeRes();
    await oauth.http({}, {}, res400, new URL('http://x/oauth/mcp/callback'), '/oauth/mcp/callback');
    T('E: callback without code → 400 + guidance', res400.statusCode === 400 && /OAuth|MCP/.test(res400.body), 'status=' + res400.statusCode);

    // full callback success path with a fresh flow
    const resFlow = await oauth.start(u, { name: 'mockai2' });
    const br2 = await fetch(resFlow.authorizeUrl, { redirect: 'manual' });
    const loc2 = br2.headers.get('location');
    const resOk = fakeRes();
    await oauth.http({}, {}, resOk, new URL(loc2), '/oauth/mcp/callback');
    T('E: callback success page rendered', resOk.statusCode === 200 && /✅|متصل/.test(resOk.body), resOk.body.slice(0, 100));

    // D5: token refresh on force
    const refreshed = await oauth.authHeaderFor(u, { force: true });
    T('D: forced refresh returns new Bearer', /^Bearer tok-/.test(String(refreshed)), String(refreshed).slice(0, 40));
    const st2 = await ctrl(mockOauth, { op: 'stats' });
    T('D: AS saw the refresh grant', st2 && st2.oauth.refresh >= 1, JSON.stringify(st2 && st2.oauth));

    // D6: bad state rejected
    const bad = await oauth.completeWithState('deadbeef', 'ac-x');
    T('D: unknown state rejected', bad && bad.ok === false && /فعال|ناشناخته/.test(bad.error || ''), JSON.stringify(bad).slice(0, 120));

    // D7: redaction — token never in registry/dynamic files
    const tokJson = JSON.parse(fs.readFileSync(process.env.JINX_MCP_TOKENS, 'utf8'));
    saveDynamic();
    const allFiles = fs.readFileSync(process.env.JINX_MCP_DYNAMIC, 'utf8') + fs.readFileSync(process.env.JINX_MCP_REGISTRY, 'utf8');
    T('F: tokens absent from registry/dynamic stores', !allFiles.includes(tokJson[u].accessToken), '');
  } finally {
    await ctrl(mockOauth, { op: 'exit' }).catch(() => {});
    mockOauth.child.kill();
  }

  // ── report ────────────────────────────────────────────────────────────────
  console.log('');
  for (const [m, n, d] of results) console.log(' ' + m + ' ' + n + (d ? '  →  ' + d : ''));
  console.log('─'.repeat(52));
  if (failed) { console.log('❌ ' + failed + ' test(s) failed'); process.exitCode = 1; return; }
  console.log('✅ ' + results.length + ' v2.1 unit tests passed');
})().catch((e) => { console.error('v2.1 suite crashed:', e); process.exitCode = 1; });
