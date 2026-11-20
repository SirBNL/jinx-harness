#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  Mock Telegram Bot API server for the Jinx E2E test.
//  Long-poll endpoint (getUpdates) returns one scripted update, then empty.
//  Every API method answers ok:true; sendMessage/editMessageText texts are
//  captured for assertions.
//
//  Usage: node test/mock-telegram.cjs
//  Stdout line: {"port":<port>}
//  stdin commands:
//    {"op":"queue","update":{...}}   queue an extra update
//    {"op":"dump"}                   reply with captured traffic
//    {"op":"exit"}
// ═══════════════════════════════════════════════════════════════════════════
'use strict';
const http = require('node:http');

const UPDATE = {
  update_id: 910001,
  message: {
    message_id: 501,
    from: { id: 70001, is_bot: false, first_name: 'E2E', username: 'e2e_user', language_code: 'en' },
    chat: { id: 70001, first_name: 'E2E', type: 'private' },
    date: Math.floor(Date.now() / 1000),
    text: 'What is 19 + 23? Use the calculator tool.',
  },
};

const TRAFFIC_FILE = process.env.MOCK_TRAFFIC_FILE || '';
function trafficLog(evt) {
  if (!TRAFFIC_FILE) return;
  try { require('node:fs').appendFileSync(TRAFFIC_FILE, JSON.stringify({ t: Date.now(), ...evt }) + '\n'); } catch { /* best-effort */ }
}

let queue = []; // starts empty — the test queues the update after MCP discovery
const traffic = { sendMessage: [], sendRichMessage: [], sendRichMessageDraft: [], editMessageText: [], other: [], getUpdates: 0, methods: {} };

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const m = /\/bot([^/]+)\/([A-Za-z]+)$/.exec(req.url || '');
    const method = m ? m[2] : 'unknown';
    traffic.methods[method] = (traffic.methods[method] || 0) + 1;
    let params = {};
    try { params = body ? JSON.parse(body) : {}; } catch { /* form-encoded? try query */ }
    if (!Object.keys(params).length && req.url.includes('?')) {
      try { params = Object.fromEntries(new URL(req.url, 'http://x').searchParams); } catch { /* ignore */ }
    }

    const json = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    trafficLog({ method, params });

    if (method === 'getUpdates') {
      traffic.getUpdates++;
      if (queue.length) {
        const out = queue;
        queue = [];
        json({ ok: true, result: out });
      } else {
        json({ ok: true, result: [] });
      }
      return;
    }
    if (method === 'getMe') {
      json({ ok: true, result: { id: 7001, is_bot: true, first_name: 'Jinx E2E', username: 'jinx_e2e_bot', can_join_groups: true } });
      return;
    }
    if (method === 'sendMessage' || method === 'editMessageText' || method === 'sendRichMessage' || method === 'sendRichMessageDraft') {
      const rich = params.rich_message || null;
      const text = String(params.text || (rich && (rich.markdown || rich.full)) || '');
      const list = traffic[method] || [];
      list.push({ text, rich: rich ? JSON.stringify(rich) : null, chat_id: params.chat_id, parse_mode: params.parse_mode, reply_markup: params.reply_markup || null, at: Date.now() });
      trafficLog({ sent: method, text });
      json({ ok: true, result: { message_id: 1000 + list.length, chat: { id: params.chat_id || 70001 } } });
      return;
    }
    // widget methods are a Jinx relay feature — a plain Bot API token 404s them,
    // and the engine must fall back to plain sendMessage. Mirror that here.
    if (/^(sendWidget|editMessageWidgetData|editMessageWidget)$/.test(method)) {
      traffic.other.push(method);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found: method not found' }));
      return;
    }
    traffic.other.push(method);
    json({ ok: true, result: true });
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n');
});

process.stdin.on('data', (d) => {
  try {
    const cmd = JSON.parse(d.toString().trim());
    if (cmd.op === 'queue') { queue.push(cmd.update); process.stdout.write(JSON.stringify({ queued: true }) + '\n'); }
    else if (cmd.op === 'dump') process.stdout.write(JSON.stringify(traffic) + '\n');
    else if (cmd.op === 'exit') { server.close(); process.exit(0); }
  } catch { /* ignore */ }
});
