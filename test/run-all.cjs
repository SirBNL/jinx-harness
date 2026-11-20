#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  Jinx Harness v2.1 — test runner
//    1. static checks   (syntax of every .cjs/.js file, bundle patches present)
//    2. unit tests      (MCP bridge: 38 checks — offline mocks)
//    3. unit v2.1       (self-connect, permission gate, OAuth: 43 checks)
//    4. E2E             (full loop: Telegram → agent → MCP → answer +
//                        agent-driven connect with permission + OAuth login)
//
//  Usage: node test/run-all.cjs        (alias: npm test)
// ═══════════════════════════════════════════════════════════════════════════
'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const sections = [];
let failed = 0;

function run(name, cmd, { timeoutMs = 180_000 } = {}) {
  const r = spawnSync(process.execPath, cmd, { cwd: ROOT, timeout: timeoutMs, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = r.status === 0 && !r.signal;
  sections.push({ name, ok, out });
  if (!ok) failed++;
  return ok;
}

console.log('🧪 Jinx Harness v2.1.0 — full test suite\n' + '═'.repeat(56));

// 1. static syntax checks
const files = ['app.js', 'check.js', 'gateway.cjs', 'mcp-bridge.cjs', 'mcp-oauth.cjs', 'setup-server.cjs', 'fetch-shim.cjs',
  'test/mock-mcp-server.cjs', 'test/mock-telegram.cjs', 'test/mock-llm.cjs',
  'test/unit-bridge.cjs', 'test/unit-v21.cjs', 'test/e2e.cjs', 'dist/portable.cjs'];
let staticOk = true;
for (const f of files) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { console.log('  ✗ missing: ' + f); staticOk = false; continue; }
  const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
  if (r.status !== 0) { console.log('  ✗ syntax error: ' + f + '\n' + (r.stderr || '').slice(0, 300)); staticOk = false; }
}
// bundle must carry the MCP hook v2 + the v2.1 engine patches
const bundle = fs.readFileSync(path.join(ROOT, 'dist', 'portable.cjs'), 'utf8');
const wired = bundle.includes('mcp-bridge.cjs").install') && bundle.includes('requestApproval: (c, n, a)') && bundle.includes('repairToolHistory');
if (!wired) { console.log('  ✗ dist/portable.cjs is not v2.1-patched (hook/OAuth route/tool-history fix missing?)'); staticOk = false; }
sections.push({ name: 'static: syntax + bundle wiring', ok: staticOk, out: '' });
if (!staticOk) failed++;
console.log((staticOk ? ' ✓' : ' ✗') + ' static: syntax (' + files.length + ' files) + bundle v2.1 wiring');

// 2. unit tests
console.log('\n── unit (MCP bridge) ' + '─'.repeat(34));
const unitOk = run('unit', ['test/unit-bridge.cjs']);
for (const line of (sections[sections.length - 1].out || '').split('\n')) {
  if (/^[ ✓✗]|✅|❌|─{10,}/.test(line)) console.log(line.replace(/\u001b\[[0-9;]*m/g, ''));
}

// 3. unit v2.1 (connect / permission / OAuth)
console.log('\n── unit v2.1 (connect • permission • OAuth) ' + '─'.repeat(12));
const unit21Ok = run('unit-v21', ['test/unit-v21.cjs']);
for (const line of (sections[sections.length - 1].out || '').split('\n')) {
  if (/^[ ✓✗]|✅|❌|─{10,}/.test(line)) console.log(line.replace(/\u001b\[[0-9;]*m/g, ''));
}

// 4. E2E
console.log('\n── end-to-end (Telegram → agent → MCP → answer → OAuth connect) ' + '─'.repeat(4));
const e2eOk = run('e2e', ['test/e2e.cjs'], { timeoutMs: 360_000 });
for (const line of (sections[sections.length - 1].out || '').split('\n')) {
  if (/^[ ✓✗]|✅|❌|─{10,}/.test(line)) console.log(line.replace(/\u001b\[[0-9;]*m/g, ''));
}

// report
console.log('\n' + '═'.repeat(56));
console.log('  static … ' + (sections[0].ok ? '✓' : '✗'));
console.log('  unit  … ' + (unitOk ? '✓ (38 checks)' : '✗'));
console.log('  v2.1  … ' + (unit21Ok ? '✓ (43 checks)' : '✗'));
console.log('  e2e   … ' + (e2eOk ? '✓ (19 checks)' : '✗'));
console.log('═'.repeat(56));
if (failed) {
  console.log('❌ failing sections: ' + sections.filter((s) => !s.ok).map((s) => s.name).join(', '));
  process.exitCode = 1;
} else {
  console.log('✅ Jinx Harness v2.1.0 — all test layers green');
}
