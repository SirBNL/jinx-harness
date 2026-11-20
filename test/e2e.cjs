#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  Jinx Harness v2 — END-TO-END test
//
//  Boots the REAL agent (patched dist/portable.cjs via app.js) against three
//  local mocks:
//    • Telegram Bot API  (long-polling getUpdates → sendMessage capture)
//    • LLM provider      (OpenAI-compatible, scripted tool-calling)
//    • MCP server        (Streamable HTTP, JSON mode)
//
//  Asserts the full loop:
//    Telegram message → agent run → model calls mcp_calc_add →
//    bridge → MCP tools/call (19+23) → result → model → final answer (42)
//    → sendMessage back to Telegram.
//
//  Usage: node test/e2e.cjs          (needs no network, no real tokens)
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
  results.push([ok ? '✓' : '✗', name, detail ? String(detail).slice(0, 240) : '']);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fullText = (m) => String((m && m.text) || '') + '\n' + String((m && m.rich) || '');
/** every outbound text channel the engine uses (rich sends land in parts + edits). */
const allOut = (d) => [...((d && d.sendMessage) || []), ...((d && d.sendRichMessage) || []), ...((d && d.editMessageText) || [])];

function startMock(file, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'test', file)], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(extraEnv || {}) } });
    let buf = '';
    child.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { const j = JSON.parse(line); if (j.port) resolve({ child, port: j.port, file }); } catch { console.error('  [' + file + ']', line.slice(0, 200)); }
      }
    });
    child.stderr.on('data', (c) => console.error('  [' + file + ':err]', String(c).trim().slice(0, 200)));
    child.on('exit', (code) => reject(new Error(file + ' exited early: ' + code)));
    setTimeout(() => reject(new Error(file + ' did not report a port in 15s')), 15_000);
  });
}
function ctrl(mock, obj) {
  return new Promise((resolve) => {
    let buf = '';
    const h = (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (l) {
          mock.child.stdout.removeListener('data', h);
          try { resolve(JSON.parse(l)); } catch { resolve(null); }
          return;
        }
      }
    };
    mock.child.stdout.on('data', h);
    mock.child.stdin.write(JSON.stringify(obj) + '\n');
    setTimeout(() => { mock.child.stdout.removeListener('data', h); resolve(null); }, 10_000).unref?.();
  });
}

(async () => {
  console.log('\n🔌 Jinx Harness v2 — end-to-end test\n' + '─'.repeat(52));

  // 1. fresh fixture from the repo tree
  const FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'jx-e2e-'));
  fs.cpSync(ROOT, FIX, { recursive: true, filter: (src) => !/[/\\](node_modules|\.git|portable[/\\]\.env)$/.test(src) });
  try { fs.rmSync(path.join(FIX, 'portable', 'data'), { recursive: true, force: true }); } catch { /* ok */ }
  fs.mkdirSync(path.join(FIX, 'portable', 'data'), { recursive: true });
  T('fixture: repo copied', fs.existsSync(path.join(FIX, 'dist', 'portable.cjs')) && fs.existsSync(path.join(FIX, 'mcp-bridge.cjs')));

  // 2. mocks (mcpOauth doubles as an OAuth authorization server)
  const tg = await startMock('mock-telegram.cjs');
  const llm = await startMock('mock-llm.cjs');
  const mcp = await startMock('mock-mcp-server.cjs');
  const mcpOauth = await startMock('mock-mcp-server.cjs', { MOCK_MCP_OAUTH: '1' });
  T('mocks: telegram/llm/mcp/mcp-oauth up', true, 'tg=' + tg.port + ' llm=' + llm.port + ' mcp=' + mcp.port + ' oauth=' + mcpOauth.port);

  // 3. fixture .env
  const envFile = [
    'BOT_TOKEN=7001:e2e-mock-token-1234567890abcdef',
    'ADMIN_ID=70001',
    'WEBHOOK_SECRET=e2e-secret-0123456789abcdef',
    'JINX_BASE_URL=http://127.0.0.1:' + llm.port + '/v1',
    'JINX_API_KEY=e2e-key-12345',
    'JINX_MODEL=e2e-model',
    'TELEGRAM_API_BASE=http://127.0.0.1:' + tg.port,
    'JINX_MCP_SERVERS=calc=http://127.0.0.1:' + mcp.port + '/mcp',
    'JINX_MCP_TIMEOUT_MS=8000',
    'JINX_PUBLIC_URL=http://127.0.0.1:46123',
    'JINX_APPROVAL_TIMEOUT_MS=45000',
    'TIMEZONE=Asia/Tehran',
    'DEFAULT_LANG=fa',
    'PORTABLE_PORT=46123',
    'JINX_BRAND_NAME=Jinx Harness',
    'JINX_ALIAS=jinx-harness',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(FIX, 'portable', '.env'), envFile);

  // 3b. PRE-SEED the MCP registry cache — the documented restart path: tools
  //     are registered synchronously at engine init, no discovery race.
  //     (Background discovery then re-scans and confirms.)
  const mcpUrl = 'http://127.0.0.1:' + mcp.port + '/mcp';
  const tool = (orig, desc, props, req) => ({ server: 'calc', orig, name: 'mcp_calc_' + orig, description: '[mcp:calc] ' + desc, inputSchema: { type: 'object', properties: props, ...(req ? { required: req } : {}) } });
  fs.writeFileSync(path.join(FIX, 'portable', 'data', 'mcp-registry.json'), JSON.stringify({
    version: 2,
    savedAt: Date.now(),
    servers: [{
      // checkedAt deliberately 2 days old → engine uses the cached tools
      // instantly AND kicks a live re-scan (both paths exercised in one run)
      name: 'calc', url: mcpUrl, ok: true, checkedAt: Date.now() - 2 * 24 * 3600 * 1000,
      tools: [
        tool('add', 'Add two integers and return the sum.', { a: { type: 'integer', description: 'first number' }, b: { type: 'integer', description: 'second number' } }, ['a', 'b']),
        tool('echo', 'Echo back the given text.', { text: { type: 'string' } }, ['text']),
        tool('get_weather', 'Fake weather for a city (test fixture).', { city: { type: 'string' } }, ['city']),
        tool('fail_always', 'Always reports an MCP error (isError: true).', {}, []),
      ],
    }],
  }, null, 2));

  // 3c. queue the Telegram message NOW — with the cache in place the tools
  //     are available the instant the engine initializes them.
  await ctrl(tg, {
    op: 'queue',
    update: {
      update_id: 910001,
      message: {
        message_id: 501,
        from: { id: 70001, is_bot: false, first_name: 'E2E', username: 'e2e_user', language_code: 'en' },
        chat: { id: 70001, first_name: 'E2E', type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'What is 19 + 23? Use the calculator tool.',
      },
    },
  });

  // 4. boot the real agent
  const bootLog = [];
  const agent = spawn(process.execPath, [path.join(FIX, 'app.js')], {
    cwd: FIX,
    env: { ...process.env, JINX_FORCE_FETCH_SHIM: '0', HOME: FIX },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agent.stdout.on('data', (c) => { bootLog.push(String(c)); });
  agent.stderr.on('data', (c) => { bootLog.push('ERR ' + String(c)); });

  const bootDeadline = Date.now() + 40_000;
  let sawMcpBoot = false, sawPoll = false;
  while (Date.now() < bootDeadline && !sawPoll) {
    await sleep(300);
    const all = bootLog.join('');
    sawMcpBoot = sawMcpBoot || /\[jinx-mcp\][^\n]*calc: 4 tool/.test(all); // ASCII-only (UTF-8 chunk splits can mangle ✓)
    sawPoll = sawPoll || /long-polling started/.test(all);
  }
  const fullLog = () => bootLog.join('').replace(/\u001b\[[0-9;]*m/g, '');
  T('boot: agent started + long-polling', sawPoll, sawPoll ? '' : fullLog().slice(-400));

  // wait for the background re-scan confirmation too (proves live discovery
  // still works next to the cache) — generous window, checked AFTER the fact
  const scanDeadline = Date.now() + 20_000;
  while (Date.now() < scanDeadline && !sawMcpBoot) {
    await sleep(300);
    sawMcpBoot = /\[jinx-mcp\][^\n]*calc: 4 tool/.test(bootLog.join(''));
  }
  T('boot: MCP bridge live re-scan confirmed (4 tools)', sawMcpBoot, sawMcpBoot ? '' : fullLog().slice(-300));

  // 6. wait for the loop to complete: a rich/send message with the answer
  let dump = null;
  const answerDeadline = Date.now() + 45_000;
  while (Date.now() < answerDeadline) {
    dump = await ctrl(tg, { op: 'dump' });
    if (!dump) break; // mock died — assert from what we have
    if (allOut(dump).some((m) => /42/.test(fullText(m)))) break;
    await sleep(500);
  }
  dump = dump || { sendMessage: [], sendRichMessage: [], editMessageText: [] };
  const llmDump = await ctrl(llm, { op: 'dump' });
  const mcpDump = await ctrl(mcp, { op: 'stats' }); // mock-mcp answers 'stats', not 'dump'
  const mcpStats = (mcpDump && mcpDump.stats) || { initialize: 0, tools_list: 0, tools_call: 0, calls: [] };

  // 7. assertions
  const toolReq = (llmDump && llmDump.requests || []).filter((r) => r.hasTools);
  const allSent = allOut(dump);
  const anySent = allSent;
  T('llm: model received the MCP tool spec', toolReq.some((r) => r.hasMcpTool), JSON.stringify(toolReq.map((r) => r.toolNames.filter((n) => n.startsWith('mcp_')))));
  T('llm: built-in tools still present next to MCP', toolReq.some((r) => r.toolNames.includes('web_search')), toolReq.length ? toolReq[0].toolNames.slice(0, 6).join(',') + '…' : 'no tool-bearing request');
  const addCall = (mcpStats.calls || []).find((c) => c.name === 'add');
  T('mcp: bridge called tools/call add', !!addCall, addCall ? JSON.stringify(addCall.args) : 'no add call seen; calls=' + JSON.stringify(mcpStats.calls).slice(0, 200));
  T('mcp: correct arguments (19, 23)', addCall && Number(addCall.args.a) === 19 && Number(addCall.args.b) === 23, addCall ? '' : '—');
  const final = allSent.find((m) => /42/.test(fullText(m)));
  T('telegram: final answer with 42 delivered', !!final, final ? '"' + fullText(final).slice(0, 120) + '"' : 'sent: ' + JSON.stringify(anySent.map((m) => fullText(m).slice(0, 60))).slice(0, 220));
  T('telegram: mcp tool never leaked to user as raw JSON', !anySent.some((m) => /"jsonrpc"/.test(m.text)), '');

  // 8. MCP traffic sanity from the server side
  T('mcp: full handshake sequence', mcpStats.initialize >= 1 && mcpStats.tools_list >= 1 && mcpStats.tools_call >= 1,
    'init=' + mcpStats.initialize + ' list=' + mcpStats.tools_list + ' call=' + mcpStats.tools_call);

  // ══════════════════════════════════════════════════════════════════════
  // 9. PHASE 2 — agent-driven connect: permission card → OAuth → callback
  // ══════════════════════════════════════════════════════════════════════
  const oauthUrl = 'http://127.0.0.1:' + mcpOauth.port + '/mcp';
  await ctrl(tg, {
    op: 'queue',
    update: {
      update_id: 910010,
      message: {
        message_id: 510,
        from: { id: 70001, is_bot: false, first_name: 'E2E', username: 'e2e_user', language_code: 'en' },
        chat: { id: 70001, first_name: 'E2E', type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'Connect to this MCP server: ' + oauthUrl,
      },
    },
  });

  // 9a. the permission card must appear (🔐 + x:appr buttons)
  let card = null;
  const cardDeadline = Date.now() + 30_000;
  while (Date.now() < cardDeadline && !card) {
    const d = await ctrl(tg, { op: 'dump' });
    if (!d) break;
    card = (d.sendMessage || []).find((m) => m.reply_markup && JSON.stringify(m.reply_markup).includes('x:appr:0:y'));
    if (!card) await sleep(500);
  }
  T('gate: permission card delivered with allow/deny buttons', !!card, card ? '' : 'no x:appr card seen');
  T('gate: card shows the target URL', !!card && card.text.includes(String(mcpOauth.port)), card ? card.text.slice(0, 160) : '');

  // 9b. click "اجازه" — a real callback_query update through the poll loop
  if (card) {
    await ctrl(tg, {
      op: 'queue',
      update: {
        update_id: 910011,
        callback_query: {
          id: 'cb-e2e-1',
          from: { id: 70001, is_bot: false, first_name: 'E2E', username: 'e2e_user' },
          message: { message_id: 999, chat: { id: 70001, type: 'private' } },
          data: 'x:appr:0:y',
        },
      },
    });
  }

  // 9c. the model relays the OAuth login URL to the user
  let authFinal = null;
  const authDeadline = Date.now() + 40_000;
  while (Date.now() < authDeadline && !authFinal) {
    const d = await ctrl(tg, { op: 'dump' });
    if (!d) break;
    // the newest message containing /authorize?
    authFinal = allOut(d).filter((m) => /\/authorize\?/.test(fullText(m))).pop() || null;
    if (!authFinal) await sleep(600);
  }
  T('oauth: login link relayed to the user', !!authFinal, authFinal ? fullText(authFinal).slice(0, 140) : 'no authorize link sent');
  if (!authFinal) {
    const dldbg = await ctrl(llm, { op: 'dump' });
    console.log('\n[debug] llm requests: ' + dldbg.requests.length);
    for (const [i, r] of dldbg.requests.entries()) console.log('[debug]  req#' + i + ' user="' + String(r.lastUser || '').slice(0, 60) + '" tool="' + String(r.lastTool || '').slice(0, 200) + '"');
    const dtdbg = await ctrl(tg, { op: 'dump' });
    console.log('[debug] tg methods: ' + JSON.stringify(dtdbg.methods));
    for (const [i, m] of (dtdbg.sendRichMessage || []).entries()) console.log('[debug]  rich#' + i + ': ' + fullText(m).slice(0, 220));
    for (const [i, m] of (dtdbg.sendMessage || []).entries()) console.log('[debug]  plain#' + i + ': ' + fullText(m).slice(0, 220));
  }

  // 9d. browser opens the link → 302 → the daemon's own /oauth/mcp/callback
  let oauthDone = null;
  if (authFinal) {
    const authorizeUrl = (fullText(authFinal).match(/https?:\/\/\S+\/authorize\?\S+/) || [''])[0];
    try {
      const br = await fetch(authorizeUrl, { redirect: 'manual' });
      const loc = br.headers.get('location') || '';
      T('oauth: authorize 302 → callback URL', /oauth\/mcp\/callback\?code=/.test(loc), loc.slice(0, 120) || 'status=' + br.status);
      if (loc) {
        const cbRes = await fetch(loc); // hits the DAEMON's real HTTP route (P5)
        const cbText = await cbRes.text();
        oauthDone = { status: cbRes.status, text: cbText };
        T('oauth: daemon served /oauth/mcp/callback (real route)', cbRes.status === 200 && /✅|متصل/.test(cbText), 'status=' + cbRes.status + ' ' + cbText.slice(0, 100));
      }
    } catch (e) {
      T('oauth: authorize 302 → callback URL', false, String(e && e.message).slice(0, 160));
    }
  } else {
    T('oauth: authorize 302 → callback URL', false, 'no login link was relayed');
  }
  T('oauth: token + dynamic server persisted on disk',
    fs.existsSync(path.join(FIX, 'portable', 'data', 'mcp-tokens.json')) &&
    fs.existsSync(path.join(FIX, 'portable', 'data', 'mcp-dynamic.json')),
    fs.readdirSync(path.join(FIX, 'portable', 'data')).join(','));

  // 9e. use a tool from the login-gated server
  await ctrl(tg, {
    op: 'queue',
    update: {
      update_id: 910020,
      message: {
        message_id: 520,
        from: { id: 70001, is_bot: false, first_name: 'E2E', username: 'e2e_user', language_code: 'en' },
        chat: { id: 70001, first_name: 'E2E', type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'Ask mockai: what is 20 + 22?',
      },
    },
  });
  let mockaiFinal = null;
  const mockaiDeadline = Date.now() + 45_000;
  while (Date.now() < mockaiDeadline && !mockaiFinal) {
    const d = await ctrl(tg, { op: 'dump' });
    if (!d) break;
    mockaiFinal = allOut(d).filter((m) => /mockai/i.test(fullText(m)) && /42/.test(fullText(m))).pop() || null;
    if (!mockaiFinal) await sleep(600);
  }
  T('oauth: login-gated tool used end-to-end (20+22=42 via mockai)', !!mockaiFinal, mockaiFinal ? fullText(mockaiFinal).slice(0, 140) : 'no mockai answer');

  const oauthStatsEnd = (await ctrl(mcpOauth, { op: 'stats' }) || {}).oauth || {};
  T('oauth: AS saw register + authorize + token', oauthStatsEnd.register >= 1 && oauthStatsEnd.authorize >= 1 && oauthStatsEnd.token >= 1, JSON.stringify(oauthStatsEnd));
  const oauthCalls = (((await ctrl(mcpOauth, { op: 'stats' }) || {}).stats) || {}).calls || [];
  T('oauth: tool call hit the auth-protected endpoint', oauthCalls.some((c) => c.name === 'add' && Number(c.args.a) === 20 && Number(c.args.b) === 22), JSON.stringify(oauthCalls).slice(0, 160));

  // 9f. negative: non-admin cannot connect
  await ctrl(tg, {
    op: 'queue',
    update: {
      update_id: 910030,
      message: {
        message_id: 530,
        from: { id: 888, is_bot: false, first_name: 'Guest', username: 'guest_user' },
        chat: { id: 888, first_name: 'Guest', type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'Connect to this MCP server: ' + oauthUrl,
      },
    },
  });
  // (the engine may ignore unknown guests entirely — the assertion is that NO
  // second approval card for this URL ever appears, and no second OAuth flow starts)
  await sleep(3000);
  const dNeg = await ctrl(tg, { op: 'dump' });
  const secondCards = ((dNeg && dNeg.sendMessage) || []).filter((m) => m.reply_markup && JSON.stringify(m.reply_markup).includes('x:appr:0:y'));
  T('gate: no second approval card for a non-admin request', secondCards.length <= 1, 'cards=' + secondCards.length);

  // cleanup
  agent.kill('SIGTERM');
  for (const m of [tg, llm, mcp, mcpOauth]) { try { await ctrl(m, { op: 'exit' }); } catch { /* already gone */ } m.child.kill(); }

  // report
  console.log('');
  for (const [mk, n, d] of results) console.log(' ' + mk + ' ' + n + (d ? '  →  ' + d : ''));
  console.log('─'.repeat(52));
  console.log(failed ? '❌ ' + failed + ' E2E check(s) failed' : '✅ E2E passed — full loop Telegram → agent → MCP → answer works');
  if (failed) console.log('\nagent log tail:\n' + fullLog().slice(-1200));

  const code = failed ? 1 : 0;
  process.stdout.write('', () => process.exit(code));
  setTimeout(() => process.exit(code), 5000).unref?.();
})().catch(async (e) => {
  console.error('E2E crashed:', e);
  process.exitCode = 1;
});
