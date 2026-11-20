#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  Mock OpenAI-compatible LLM provider for the Jinx E2E test.
//  Scripted, context-aware agent behavior:
//
//    • tools incl. mcp_calc_add, no tool result yet      → mcp_calc_add(19,23)
//    • mcp_calc_add result in context                    → final answer "42"
//    • user asks to connect an MCP server (text has URL,
//      tools incl. mcp_connect, no mcp_connect result)   → mcp_connect({url})
//    • mcp_connect result carries authorizeUrl           → final: relay URL
//    • user pasted an /oauth/mcp/callback URL            → mcp_oauth_complete
//    • mcp_oauth_complete ok                             → final "connected"
//    • every other call (memory extractor etc.)          → neutral "[]"
//
//  Supports streaming (SSE chunks) and non-streaming JSON.
//
//  Usage: node test/mock-llm.cjs
//  Stdout: {"port":<port>}
//  stdin:  {"op":"dump"} → captured requests  |  {"op":"exit"}
// ═══════════════════════════════════════════════════════════════════════════
'use strict';
const http = require('node:http');

const captured = { requests: [] }; // {hasTools, toolNames, nMessages, stream, lastUser, lastTool}
let toolTurn = 0;

function lastOf(messages, role) {
  const list = (messages || []).filter((m) => m.role === role);
  return list.length ? list[list.length - 1] : null;
}
function anyToolResult(messages, needle) {
  return (messages || []).some((m) => {
    if (m.role !== 'tool' || typeof m.content !== 'string') return false;
    // the engine JSON-stringifies tool results (sometimes twice) — unescape
    // progressively so needle matching works at any escaping depth
    let c = m.content;
    for (let i = 0; i < 4 && /\\["\\/u]/.test(c); i++) c = c.replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
    return c.includes(needle);
  });
}
/** has the assistant already issued a tool_call with this name in this conversation? */
function calledTool(messages, name) {
  return (messages || []).some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) &&
    m.tool_calls.some((tc) => tc && tc.function && tc.function.name === name));
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = req.url || '';

    if (url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'e2e-model' }] }));
      return;
    }
    if (!url.endsWith('/chat/completions')) {
      res.writeHead(404); res.end('{}'); return;
    }

    let j = {};
    try { j = JSON.parse(body); } catch { /* ignore */ }
    const toolNames = (j.tools || []).map((t) => t.function && t.function.name).filter(Boolean);
    const msgs = j.messages || [];
    const lastUser = lastOf(msgs, 'user');
    const lastUserText = String((lastUser && lastUser.content) || '');
    const lastToolMsg = lastOf(msgs, 'tool');
    const rec = {
      hasTools: toolNames.length > 0,
      hasMcpTool: toolNames.includes('mcp_calc_add'),
      toolNames, nMessages: msgs.length, stream: !!j.stream,
      lastUser: lastUserText.slice(0, 200), lastTool: lastToolMsg ? String(lastToolMsg.content).slice(0, 300) : null,
    };
    captured.requests.push(rec);

    const reply = (message, finish) => {
      if (j.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const delta = message.tool_calls
          ? { role: 'assistant', tool_calls: message.tool_calls }
          : { role: 'assistant', content: message.content };
        res.write('data: ' + JSON.stringify({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl-e2e', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
      }
    };
    const toolCall = (id, name, args) => reply({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');

    // ── phase 2: agent-driven MCP connect (permission gate + OAuth) ──────────
    // (paste branch first — the pasted callback URL also contains "/mcp")
    if (/oauth\/mcp\/callback\?/.test(lastUserText) && toolNames.includes('mcp_oauth_complete')) {
      if (!calledTool(msgs, 'mcp_oauth_complete')) {
        const pasted = (lastUserText.match(/https?:\/\/\S+oauth\/mcp\/callback\?\S+/) || [''])[0].replace(/[)\]}>,.»"]+$/, '');
        toolCall('call_e2e_3', 'mcp_oauth_complete', { url_or_code: pasted });
        return;
      }
      reply({ role: 'assistant', content: 'سرور با موفقیت وصل شد ✓' }, 'stop');
      return;
    }
    if (/connect|وصل/i.test(lastUserText) && /https?:\/\/\S+\/mcp/.test(lastUserText) && toolNames.includes('mcp_connect')) {
      if (!calledTool(msgs, 'mcp_connect')) {
        const mUrl = lastUserText.match(/https?:\/\/\S+\/mcp/)[0].replace(/[)\]}>,.»"]+$/, '');
        toolCall('call_e2e_2', 'mcp_connect', { url: mUrl, name: 'mockai' });
        return;
      }
      if (anyToolResult(msgs, 'authorizeUrl')) {
        const tm = (msgs.filter((m) => m.role === 'tool' && /authorizeUrl/.test(String(m.content)))).pop();
        let authUrl = '';
        try {
          // tool results arrive doubly JSON-stringified — unwrap progressively
          let p = tm.content;
          for (let i = 0; i < 3; i++) { const q = JSON.parse(p); if (typeof q === 'string') p = q; else { p = q; break; } }
          authUrl = (p && (p.result ? p.result.authorizeUrl : p.authorizeUrl)) || '';
        } catch { /* fall back to regex below */ }
        if (!authUrl) authUrl = (String(tm.content).match(/https?:\/\/[^"'\s\\]+/g) || [''])[0];
        reply({ role: 'assistant', content: 'برای لاگین این لینک را باز کن:\n' + authUrl }, 'stop');
        return;
      }
      if (anyToolResult(msgs, 'مجاز نشد') || anyToolResult(msgs, 'Approval timeout')) {
        reply({ role: 'assistant', content: 'اتصال مجاز نشد — به کاربر اطلاع دادم.' }, 'stop');
        return;
      }
      reply({ role: 'assistant', content: 'سرور متصل شد ✓' }, 'stop');
      return;
    }

    // ── phase 1 + 3: calculators (built-in calc server / OAuth-connected mockai) ─
    const mockaiRequest = /mockai/i.test(lastUserText);
    const calcRequest = mockaiRequest || /(?:19\s*\+\s*23|calculator|What is)/i.test(lastUserText);
    if (calcRequest) {
      const tool = mockaiRequest ? 'mcp_mockai_add' : 'mcp_calc_add';
      const args = mockaiRequest ? { a: 20, b: 22 } : { a: 19, b: 23 };
      if (toolNames.includes(tool) && !calledTool(msgs, tool)) {
        toolCall('call_e2e_1', tool, args);
        return;
      }
      if (calledTool(msgs, tool)) {
        reply({ role: 'assistant', content: mockaiRequest
          ? 'The mockai MCP server computed 20 + 22 = 42 — login-gated tools work.'
          : '19 + 23 = 42. Computed with the MCP calculator tool — answer delivered.' }, 'stop');
        return;
      }
    }

    // ── neutral (memory extractor, etc.) ─────────────────────────────────────
    reply({ role: 'assistant', content: '[]' }, 'stop');
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n');
});

process.stdin.on('data', (d) => {
  try {
    const cmd = JSON.parse(d.toString().trim());
    if (cmd.op === 'dump') process.stdout.write(JSON.stringify(captured) + '\n');
    else if (cmd.op === 'exit') { server.close(); process.exit(0); }
  } catch { /* ignore */ }
});
