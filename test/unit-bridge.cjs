#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  Jinx Harness v2 — MCP bridge unit tests
//  Runs fully offline against local mock MCP servers (JSON + SSE + auth +
//  pagination + session-expiry variants). No Telegram, no LLM, no network.
//
//  Usage: node test/unit-bridge.cjs
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

// hermetic paths for this test run
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jinx-mcp-test-'));
process.env.JINX_MCP_JSON = path.join(TMP, 'no-mcp.json');
process.env.JINX_MCP_REGISTRY = path.join(TMP, 'registry.json');
delete process.env.JINX_MCP_SERVERS;
delete process.env.JINX_MCP_OFF;

const bridge = require(path.join(ROOT, 'mcp-bridge.cjs'));
const { state, parseEnvServers, normalizeSchema, sseMessages, toolRecord, loadRegistryCache, saveRegistry, syncTools, metaTools } = bridge._internal;

// ── spawn helper ────────────────────────────────────────────────────────────
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
      try { const j = JSON.parse(line); if (j.port) resolve({ child, port: j.port }); }
      catch { if (/error/i.test(line)) console.error('  [mock]', line); }
    };
    child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on('data', (c) => console.error('  [mock:err]', String(c).trim()));
  });
}
function ctrl(mock, obj) {
  return new Promise((resolve) => {
    let buf = '';
    const onLine = (line) => { try { resolve(JSON.parse(line.trim())); } catch { /* wait */ } };
    mock.child.stdout.on('data', function h(c) {
      buf += c; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { mock.child.stdout.removeListener('data', h); onLine(l); return; } }
    });
    mock.child.stdin.write(JSON.stringify(obj) + '\n');
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// synthetic engine registries (same shapes the bundle uses)
function freshRegistries() {
  const ALL_TOOLS = [{ meta: { name: 'web_search', group: 'web_search', spec: { type: 'function', function: { name: 'web_search', description: 'built-in', parameters: { type: 'object', properties: {} } } } }, handler: async () => ({}) }];
  const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.meta.name, t]));
  return { ALL_TOOLS, BY_NAME };
}
function resetBridge() {
  state.installed = false; state.servers = []; state.live.clear();
  state.ALL_TOOLS = null; state.BY_NAME = null; state.refreshing = null;
}

(async () => {
  console.log('\n🧪 Jinx MCP bridge — unit tests\n' + '─'.repeat(52));

  // ── 1. pure functions ─────────────────────────────────────────────────────
  const cfgServers = parseEnvServers({ JINX_MCP_SERVERS: 'calc=http://x/mcp, http://bare.example.com/mcp, # comment, not-a-url, weird=ftp://no' });
  eq(cfgServers.length, 2, 'env: parses name=url + bare url, drops junk');
  eq(cfgServers[0].name, 'calc', 'env: explicit name kept');
  eq(cfgServers[1].name, 'bare', 'env: name derived from hostname');

  const norm = normalizeSchema({ $schema: 'http://x', additionalProperties: false, type: 'object', properties: { a: { description: 'x', type: 'string' } } });
  eq(norm, { type: 'object', properties: { a: { description: 'x', type: 'string' } } }, 'schema: $schema/additionalProperties stripped');
  eq(normalizeSchema({ type: 'integer' }), { type: 'object', properties: { value: { type: 'integer' } } }, 'schema: non-object wrapped');
  eq(normalizeSchema('junk'), { type: 'object', properties: { value: { type: 'string' } } }, 'schema: junk → string');

  const sseParsed = sseMessages('event: message\ndata: {"id":1,"result":{"a":1}}\n\ndata: [DONE]\n\nevent: message\ndata: {"id":2,"result":{"a":2}}\n\n', 1);
  eq(sseParsed.length, 1, 'sse: filters by request id, skips [DONE]');
  eq(sseParsed[0].result.a, 1, 'sse: correct message picked');

  const rec = toolRecord({ name: 'Srv One' }, { name: 'Weird-Tool!', description: 'x'.repeat(2000), inputSchema: {} });
  eq(rec.name, 'mcp_srv_one_weird_tool', 'toolRecord: sanitized full name');
  T('toolRecord: description clipped to cap', rec.description.length <= 902, rec.description.length);

  // ── 2. install without servers ────────────────────────────────────────────
  resetBridge();
  const reg0 = freshRegistries();
  bridge.install(reg0);
  T('install: no servers → meta tools only', reg0.ALL_TOOLS.length === 6 && reg0.BY_NAME.has('mcp_servers') && reg0.BY_NAME.has('mcp_refresh') && reg0.BY_NAME.has('mcp_connect'), reg0.ALL_TOOLS.map((t) => t.meta.name).join(','));
  T('install: idempotent', (bridge.install(reg0), reg0.ALL_TOOLS.length === 6), 'second install ignored');

  // ── 3. discovery against JSON-mode mock ───────────────────────────────────
  const mockJson = await startMock({});
  try {
    resetBridge();
    process.env.JINX_MCP_SERVERS = 'calc=http://127.0.0.1:' + mockJson.port + '/mcp';
    const reg1 = freshRegistries();
    bridge.install(reg1);
    await sleep(50);
    const r = await bridge.refresh();
    console.error('MARK: refresh done', JSON.stringify(r.servers));
    T('discovery: server ok', r.servers.length === 1 && r.servers[0].ok === true, JSON.stringify(r.servers));
    eq(r.added, 4, 'discovery: 4 tools added');
    T('discovery: names registered', ['mcp_calc_add', 'mcp_calc_echo', 'mcp_calc_get_weather', 'mcp_calc_fail_always'].every((n) => reg1.BY_NAME.has(n)), [...reg1.BY_NAME.keys()].join(','));
    const spec = reg1.BY_NAME.get('mcp_calc_add').meta.spec.function;
    T('discovery: spec shape for provider', spec.name === 'mcp_calc_add' && spec.parameters.type === 'object' && spec.parameters.properties.a.type === 'integer' && !('$schema' in spec.parameters), JSON.stringify(spec.parameters).slice(0, 120));
    T('discovery: description tagged', spec.description.startsWith('[mcp:calc]'), spec.description.slice(0, 30));

    // call tools through the registered handler
    const addTool = reg1.BY_NAME.get('mcp_calc_add');
    const r1 = await addTool.handler({}, { a: 19, b: 23 });
    console.error('MARK: add handler done', JSON.stringify(r1));
    eq(r1.content, '42', 'call: add(19,23) = 42');
    T('call: metadata attached', r1.mcp.server === 'calc' && r1.mcp.tool === 'add' && typeof r1.mcp.ms === 'number', JSON.stringify(r1.mcp));
    const r2 = await reg1.BY_NAME.get('mcp_calc_echo').handler({}, { text: 'سلام جینکس' });
    eq(r2.content, 'echo: سلام جینکس', 'call: echo utf-8 round-trip');
    const r3 = await reg1.BY_NAME.get('mcp_calc_fail_always').handler({}, {});
    T('call: isError → {error} shape', r3 && typeof r3.error === 'string' && r3.error.includes('mock tool failed'), JSON.stringify(r3));
    const r4 = await addTool.handler({}, { a: 'x', b: 1 });
    eq(r4.content, '1', 'call: bad ints degraded to 0 (server-side coercion)');

    // meta tools
    const listOut = await reg1.BY_NAME.get('mcp_servers').handler({}, {});
    T('meta: mcp_servers lists calc', /calc/.test(listOut.content) && listOut.servers[0].tools === 4, listOut.content);
    const refOut = await reg1.BY_NAME.get('mcp_refresh').handler({}, {});
    T('meta: mcp_refresh works', /calc: ok/.test(refOut.content), refOut.content);

    // session expiry → transparent re-init
    console.error('MARK: before expire');
    await ctrl(mockJson, { op: 'expire' });
    console.error('MARK: expire done');
    const r5 = await addTool.handler({}, { a: 2, b: 3 });
    console.error('MARK: retry after expiry', JSON.stringify(r5));
    eq(r5.content, '5', 'resilience: stale session → re-init → retry succeeds');

    // registry cache round-trip without network
    saveRegistry();
    T('cache: file written', fs.existsSync(process.env.JINX_MCP_REGISTRY));
    state.live.clear();
    const okLoad = loadRegistryCache();
    const r6 = syncTools();
    T('cache: reload registers tools offline', okLoad && r6.added === 4, JSON.stringify(r6));
    const r7 = await state.BY_NAME.get('mcp_calc_add').handler({}, { a: 10, b: -4 });
    eq(r7.content, '6', 'cache: cached tool still calls live server');
    // restore live state for later steps
    await bridge.refresh();
    console.error('MARK: section3 try complete');
  } finally {
    console.error('MARK: section3 finally');
    await ctrl(mockJson, { op: 'exit' }).catch(() => {});
    mockJson.child.kill();
    delete process.env.JINX_MCP_SERVERS;
  }

  // ── 4. SSE-mode mock ──────────────────────────────────────────────────────
  const mockSse = await startMock({ MOCK_MCP_SSE: '1' });
  try {
    resetBridge();
    process.env.JINX_MCP_SERVERS = 'http://127.0.0.1:' + mockSse.port + '/mcp';
    const reg2 = freshRegistries();
    bridge.install(reg2);
    const r = await bridge.refresh();
    T('sse: discovery ok', r.servers[0] && r.servers[0].ok === true && r.added === 4, JSON.stringify(r));
    const out = await reg2.BY_NAME.get('mcp_127_get_weather').handler({}, { city: 'Tehran' });
    T('sse: tools/call via SSE stream', /Tehran/.test(out.content), out.content);
  } finally {
    await ctrl(mockSse, { op: 'exit' }).catch(() => {});
    mockSse.child.kill();
    delete process.env.JINX_MCP_SERVERS;
  }

  // ── 5. auth-rejecting mock ────────────────────────────────────────────────
  const mockAuth = await startMock({ MOCK_MCP_AUTH: 'Bearer secret123' });
  try {
    resetBridge();
    process.env.JINX_MCP_SERVERS = 'locked=http://127.0.0.1:' + mockAuth.port + '/mcp';
    const reg3 = freshRegistries();
    bridge.install(reg3);
    const r = await bridge.refresh();
    T('auth: rejected server marked error', r.servers[0].ok === false && /401|auth/i.test(r.servers[0].error || ''), JSON.stringify(r.servers[0]));
    T('auth: no tools registered', r.added === 0 && !reg3.BY_NAME.has('mcp_locked_add'), '');
    // now with the right key — like an owner fixing config and restarting
    process.env.JINX_MCP_AUTH_LOCKED = 'Bearer secret123';
    const reg3b = freshRegistries();
    resetBridge();
    bridge.install(reg3b);
    const r2 = await bridge.refresh();
    T('auth: correct key → tools registered', r2.added === 4 && reg3b.BY_NAME.has('mcp_locked_add'), JSON.stringify(r2.servers[0]));
    const lockedAdd = await reg3b.BY_NAME.get('mcp_locked_add').handler({}, { a: 7, b: 8 });
    eq(lockedAdd.content, '15', 'auth: authenticated call works');
    delete process.env.JINX_MCP_AUTH_LOCKED;
  } finally {
    await ctrl(mockAuth, { op: 'exit' }).catch(() => {});
    mockAuth.child.kill();
    delete process.env.JINX_MCP_SERVERS;
  }

  // ── 6. pagination ─────────────────────────────────────────────────────────
  const mockPage = await startMock({ MOCK_MCP_PAGE: '1' });
  try {
    resetBridge();
    process.env.JINX_MCP_SERVERS = 'paged=http://127.0.0.1:' + mockPage.port + '/mcp';
    const reg4 = freshRegistries();
    bridge.install(reg4);
    const r = await bridge.refresh();
    T('pagination: all pages followed', r.added === 4, JSON.stringify(r));
  } finally {
    await ctrl(mockPage, { op: 'exit' }).catch(() => {});
    mockPage.child.kill();
    delete process.env.JINX_MCP_SERVERS;
  }

  // ── 7. dead server / bad url ──────────────────────────────────────────────
  resetBridge();
  process.env.JINX_MCP_SERVERS = 'dead=http://127.0.0.1:9/mcp';
  const reg5 = freshRegistries();
  bridge.install(reg5);
  const r5 = await bridge.refresh();
  T('dead server: error captured, no crash', r5.servers[0].ok === false && r5.added === 0, JSON.stringify(r5.servers[0]).slice(0, 140));
  delete process.env.JINX_MCP_SERVERS;

  // ── 8. redaction: auth never appears in registry file ─────────────────────
  const mockAuth2 = await startMock({ MOCK_MCP_AUTH: 'Bearer supersecret999' });
  try {
    resetBridge();
    process.env.JINX_MCP_SERVERS = 'sec=http://127.0.0.1:' + mockAuth2.port + '/mcp';
    process.env.JINX_MCP_AUTH_SEC = 'Bearer supersecret999';
    const reg6 = freshRegistries();
    bridge.install(reg6);
    await bridge.refresh();
    saveRegistry();
    const raw = fs.readFileSync(process.env.JINX_MCP_REGISTRY, 'utf8');
    const leakAt = raw.indexOf('supersecret999');
    T('redaction: secret absent from registry cache', leakAt === -1,
      leakAt === -1 ? '' : 'CONTEXT: ' + JSON.stringify(raw.slice(Math.max(0, leakAt - 150), leakAt + 60)) + ' || path=' + process.env.JINX_MCP_REGISTRY);
    const listOut = await reg6.BY_NAME.get('mcp_servers').handler({}, {});
    const s2 = JSON.stringify(listOut);
    const leak2 = s2.indexOf('supersecret999');
    T('redaction: secret absent from mcp_servers output', leak2 === -1,
      leak2 === -1 ? '' : 'CTX2: ' + s2.slice(Math.max(0, leak2 - 150), leak2 + 60));
  } finally {
    await ctrl(mockAuth2, { op: 'exit' }).catch(() => {});
    mockAuth2.child.kill();
    delete process.env.JINX_MCP_SERVERS;
    delete process.env.JINX_MCP_AUTH_SEC;
  }

  // ── report ────────────────────────────────────────────────────────────────
  console.log('');
  for (const [m, n, d] of results) console.log(' ' + m + ' ' + n + (d ? '  →  ' + d : ''));
  console.log('─'.repeat(52));
  if (failed) { console.log('❌ ' + failed + ' test(s) failed'); process.exitCode = 1; return; }
  console.log('✅ ' + results.length + ' unit tests passed');
})().catch((e) => { console.error('unit suite crashed:', e); process.exitCode = 1; });
