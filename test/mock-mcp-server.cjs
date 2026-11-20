#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  Mock MCP server for the Jinx test-suite.
//  Speaks Streamable HTTP (JSON or SSE responses — switchable per tool),
//  supports pagination, required auth, and session-expiry simulation.
//
//  Usage: node test/mock-mcp-server.cjs [port]
//  Env:   MOCK_MCP_AUTH="Bearer test123"   require this Authorization
//         MOCK_MCP_SSE=1                   answer tools/call via SSE
//  Print: {"port":<port>} on stdout, then serves until killed.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.argv[2] || process.env.MOCK_MCP_PORT || 0) || 0;
const NEED_AUTH = process.env.MOCK_MCP_AUTH || '';
const SSE_MODE = process.env.MOCK_MCP_SSE === '1';
// OAuth mode: this same process ALSO acts as the authorization server
// (protected-resource metadata, AS metadata, DCR, authorize, token).
const OAUTH_MODE = process.env.MOCK_MCP_OAUTH === '1';
const VALID_TOKENS = new Set();      // access tokens issued by /token
const CODES = new Map();             // code -> {challenge, redirectUri, clientId, expiresAt}
const CLIENTS = new Map();           // client_id -> {redirectUis}
let oauthStats = { register: 0, authorize: 0, token: 0, refresh: 0, rejected: 0 };

const TOOLS = [
  {
    name: 'add',
    description: 'Add two integers and return the sum.',
    inputSchema: { type: 'object', properties: { a: { type: 'integer', description: 'first number' }, b: { type: 'integer', description: 'second number' } }, required: ['a', 'b'], additionalProperties: false, $schema: 'http://json-schema.org/draft-07/schema#' },
  },
  {
    name: 'echo',
    description: 'Echo back the given text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'get_weather',
    description: 'Fake weather for a city (test fixture).',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
  {
    name: 'fail_always',
    description: 'Always reports an MCP error (isError: true).',
    inputSchema: { type: 'object', properties: {} },
  },
];

let session = 'sess-' + crypto.randomBytes(6).toString('hex');
let sessionGeneration = 0;
const stats = { initialize: 0, tools_list: 0, tools_call: 0, calls: [] };

function json(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(body);
}
function sse(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'text/event-stream', ...headers });
  res.write('event: message\ndata: ' + JSON.stringify(obj) + '\n\n');
  res.end();
}
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

/** Serve one MCP JSON-RPC message (auth already validated). */
function serveMcp(req, res, msg) {
  // initialize
  if (msg.method === 'initialize') {
    stats.initialize++;
    session = 'sess-' + crypto.randomBytes(6).toString('hex');
    sessionGeneration++;
    const reply = { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '1.0.0' } } };
    json(res, 200, reply, { 'Mcp-Session-Id': session });
    return;
  }
  // notification
  if (msg.id === undefined) { res.writeHead(202); res.end(); return; }

  // session guard — reject stale ids (simulates expiry after re-init)
  if (req.headers['mcp-session-id'] && req.headers['mcp-session-id'] !== session) {
    json(res, 400, { jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Session terminated. Re-initialize.' } });
    return;
  }

  if (msg.method === 'tools/list') {
    stats.tools_list++;
    const paginate = process.env.MOCK_MCP_PAGE === '1' || (msg.params && msg.params.cursor !== undefined);
    if (!paginate) {
      const reply = { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
      if (SSE_MODE) sse(res, 200, reply); else json(res, 200, reply);
    } else {
      const start = Number(msg.params.cursor) || 0;
      const page = TOOLS.slice(start, start + 2);
      const next = start + 2 < TOOLS.length ? String(start + 2) : undefined;
      const reply = { jsonrpc: '2.0', id: msg.id, result: { tools: page, ...(next ? { nextCursor: next } : {}) } };
      if (SSE_MODE) sse(res, 200, reply); else json(res, 200, reply);
    }
    return;
  }

  if (msg.method === 'tools/call') {
    stats.tools_call++;
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    stats.calls.push({ name, args });
    let result;
    if (name === 'add') result = { content: [{ type: 'text', text: String((Number(args.a) || 0) + (Number(args.b) || 0)) }] };
    else if (name === 'echo') result = { content: [{ type: 'text', text: 'echo: ' + String(args.text ?? '') }] };
    else if (name === 'get_weather') result = { content: [{ type: 'text', text: JSON.stringify({ city: args.city, temp_c: 21, condition: 'clear (mock)' }) }] };
    else if (name === 'fail_always') result = { content: [{ type: 'text', text: 'mock tool failed on purpose' }], isError: true };
    else result = { content: [{ type: 'text', text: 'unknown tool: ' + name }], isError: true };
    const reply = { jsonrpc: '2.0', id: msg.id, result };
    if (SSE_MODE) sse(res, 200, reply); else json(res, 200, reply);
    return;
  }

  json(res, 404, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found: ' + msg.method } });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://127.0.0.1');
  const base = 'http://127.0.0.1:' + (server.address() ? server.address().port : PORT);

  // ── authorization-server surface (OAuth mode) ─────────────────────────────
  if (OAUTH_MODE && req.method === 'GET' && u.pathname === '/.well-known/oauth-protected-resource') {
    json(res, 200, { resource: base + '/mcp', authorization_servers: [base] });
    return;
  }
  if (OAUTH_MODE && req.method === 'GET' && u.pathname === '/.well-known/oauth-authorization-server') {
    json(res, 200, {
      issuer: base,
      authorization_endpoint: base + '/authorize',
      token_endpoint: base + '/token',
      registration_endpoint: base + '/register',
      scopes_supported: ['mcp:read', 'mcp:write'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
    });
    return;
  }
  if (OAUTH_MODE && req.method === 'POST' && u.pathname === '/register') {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(body); } catch { /* */ }
      oauthStats.register++;
      if (!Array.isArray(j.redirect_uris) || !j.redirect_uris.length) { json(res, 400, { error: 'invalid_redirect_uri' }); return; }
      if (j.token_endpoint_auth_method !== 'none') { json(res, 400, { error: 'unsupported_auth_method' }); return; }
      const clientId = 'cli-' + crypto.randomBytes(8).toString('hex');
      CLIENTS.set(clientId, { redirectUris: j.redirect_uris });
      json(res, 201, { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
    });
    return;
  }
  if (OAUTH_MODE && req.method === 'GET' && u.pathname === '/authorize') {
    oauthStats.authorize++;
    const p = u.searchParams;
    const clientId = p.get('client_id');
    const redirectUri = p.get('redirect_uri');
    const client = CLIENTS.get(clientId);
    if (!client || !client.redirectUris.includes(redirectUri)) { json(res, 400, { error: 'invalid_client_or_redirect' }); return; }
    if (p.get('response_type') !== 'code') { json(res, 400, { error: 'unsupported_response_type' }); return; }
    if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) { json(res, 400, { error: 'pkce_required' }); return; }
    const state = p.get('state') || '';
    const code = 'ac-' + crypto.randomBytes(10).toString('hex');
    CODES.set(code, { challenge: p.get('code_challenge'), redirectUri, clientId, expiresAt: Date.now() + 120_000 });
    const out = new URL(redirectUri);
    out.searchParams.set('code', code);
    out.searchParams.set('state', state);
    res.writeHead(302, { Location: out.toString() });
    res.end();
    return;
  }
  if (OAUTH_MODE && req.method === 'POST' && u.pathname === '/token') {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = new URLSearchParams(body);
      const grant = p.get('grant_type');
      if (grant === 'authorization_code') {
        oauthStats.token++;
        const rec = CODES.get(p.get('code'));
        if (!rec || rec.expiresAt < Date.now()) { json(res, 400, { error: 'invalid_grant' }); return; }
        CODES.delete(p.get('code')); // single use
        if (p.get('client_id') !== rec.clientId || p.get('redirect_uri') !== rec.redirectUri) { json(res, 400, { error: 'mismatched_client' }); return; }
        const verifier = p.get('code_verifier') || '';
        const expect = b64url(crypto.createHash('sha256').update(verifier).digest());
        if (expect !== rec.challenge) { oauthStats.rejected++; json(res, 400, { error: 'invalid_grant', hint: 'pkce mismatch' }); return; }
        const access = 'tok-' + crypto.randomBytes(12).toString('hex');
        const refresh = 'ref-' + crypto.randomBytes(12).toString('hex');
        VALID_TOKENS.add(access);
        json(res, 200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 900, scope: 'mcp:read mcp:write' });
        return;
      }
      if (grant === 'refresh_token') {
        oauthStats.refresh++;
        const refresh = p.get('refresh_token') || '';
        if (!/^ref-[0-9a-f]{24}$/.test(refresh)) { json(res, 400, { error: 'invalid_grant' }); return; }
        const access = 'tok-' + crypto.randomBytes(12).toString('hex');
        VALID_TOKENS.add(access);
        json(res, 200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 900 });
        return;
      }
      json(res, 400, { error: 'unsupported_grant_type' });
    });
    return;
  }

  // ── MCP surface ───────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    if (OAUTH_MODE && u.pathname === '/mcp') { res.writeHead(405); res.end(); return; }
    res.writeHead(405); res.end(); return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch { json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }

    const authHeader = req.headers['authorization'] || '';
    if (OAUTH_MODE) {
      if (!authHeader.startsWith('Bearer ') || !VALID_TOKENS.has(authHeader.slice(7))) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer resource_metadata_uri="' + base + '/.well-known/oauth-protected-resource"',
        });
        res.end(JSON.stringify({ error: 'unauthorized', realm: 'mock-oauth' }));
        return;
      }
    } else if (NEED_AUTH && authHeader !== NEED_AUTH) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }

    serveMcp(req, res, msg);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: server.address().port, sse: SSE_MODE, auth: !!NEED_AUTH, oauth: OAUTH_MODE }) + '\n');
});

// test controls via stdin commands
process.stdin.on('data', (d) => {
  try {
    const cmd = JSON.parse(d.toString().trim());
    if (cmd.op === 'stats') process.stdout.write(JSON.stringify({ stats, oauth: oauthStats, tokens: VALID_TOKENS.size }) + '\n');
    else if (cmd.op === 'expire') { session = 'sess-invalidated'; sessionGeneration++; process.stdout.write(JSON.stringify({ expired: true }) + '\n'); }
    else if (cmd.op === 'exit') {
      process.stdout.write(JSON.stringify({ exited: true }) + '\n');
      setTimeout(() => { server.close(); process.exit(0); }, 50);
    }
  } catch { /* ignore */ }
});
