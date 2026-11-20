# Changelog

## v2.1.0 — "Connect it yourself" (2026-11-20)

The headline: **the agent can now connect MCP servers itself — with a human permission gate — and login-required (OAuth) servers just work.** Tell it *"connect to https://mcp.example.com/mcp"*; it shows you a 🔐 approval card (Allow / Deny / allow-for-this-run), then figures out what the server needs: nothing, an API key, or a full OAuth login.

### Added

- **Agent self-connect (`mcp_connect`)** — ADMIN-only tool that:
  - fires the engine's real approval card before any request leaves the host (block-until-decided, 8-min window, every decision logged)
  - preflights the server and auto-detects the auth shape: no-auth / API-key / OAuth
  - persists approved servers to `portable/data/mcp-dynamic.json` (survives restarts, removable with `mcp_disconnect`)
  - `JINX_MCP_ALLOW_CONNECT=0` disables the whole path for paranoid hosts
- **MCP OAuth module (`mcp-oauth.cjs`)** — full MCP authorization (spec 2025-06-18) for login-required servers (Higgsfield, Runway, HeyGen style):
  - 401 → protected-resource metadata → authorization-server metadata
  - OAuth 2.0 Dynamic Client Registration (RFC 7591), public client, no secrets on disk beyond the tokens themselves
  - Authorization-code flow with **PKCE (S256)**; the callback is served by the agent itself at `/oauth/mcp/callback` (works through `index.cgi` / `jadmin.cgi` on shared hosting — set `JINX_PUBLIC_URL`)
  - manual fallback: the user copies the final browser URL into the chat and the agent finishes the exchange (`mcp_oauth_complete`)
  - tokens stored chmod-600, auto-refreshed on expiry, refreshed-and-retried on 401
- **API-key servers as first-class citizens**: `mcp_connect(url, {apiKey})` tries `Authorization: Bearer`, falls back to `X-Api-Key`
- **`/oauth/mcp/status`** endpoint — JSON view of pending flows and stored tokens (no secrets) for quick debugging
- Meta tools for the model: `mcp_connect`, `mcp_disconnect`, `mcp_oauth_complete` next to `mcp_servers` / `mcp_refresh`

### Fixed

- **The tool-history 400 loop** (the "bot stopped answering" bug): `repairToolHistory()` is now injected into the engine's request builder — a malformed tool exchange (orphan `tool` message, dangling `tool_calls` without results, duplicate results, empty tool content) can never reach a strict OpenAI-compatible provider again. The checkpoint size-trimmer is also tool-safe now (its 20-message window can no longer start on an orphaned `tool` message after a resume), and a 400 that is specifically a tool-ordering error is no longer pointlessly retried on the fallback provider.

### Engine bundle

- `dist/portable.cjs` carries seven byte-precise patches on top of the v2.0.0 bundle (all verified by `node --check` + the test suite): tool-history repair, tool-safe checkpoint trim, failover carve-out, `requestApproval` export (the permission gate), the `/oauth/mcp/*` route, the MCP hook v2 (passes the gate to the bridge), and the version bump to `9.3.1-oss`.

### Tests

- 43 new unit checks (`test/unit-v21.cjs`): permission gate (non-admin / denied / approved), API-key paths, the complete OAuth flow against a mock authorization server (DCR → PKCE → code exchange → refresh → callback handler → manual paste), disconnect + persistence + redaction
- E2E grew from 11 to 19 checks: the real engine now walks the whole journey — connect request → approval card → button click → OAuth login link relayed → browser redirect → **the daemon's own `/oauth/mcp/callback` route** → token stored → login-gated tool called end-to-end
- Mocks upgraded: the mock MCP server can also act as a full OAuth authorization server; the mock Telegram mirrors real Bot API behavior for widget methods (404 → plain-message fallback); the mock LLM is context-aware
- Full suite: **static + 38 + 43 + 19 = 100 checks**, all offline

## v2.0.0 — "The whole tool internet" (2026-11-19)

The headline: **a built-in MCP client.** Connect any Model Context Protocol server over Streamable HTTP and every tool it exposes becomes a first-class agent tool — no code, no rebuild, no npm install. *"Give any model hands"* now means *all the hands*.

### Added

- **MCP client bridge** (`mcp-bridge.cjs`, wired into the engine bundle):
  - Streamable HTTP transport (JSON-RPC 2.0, protocol `2025-06-18`) with JSON **and** SSE response handling
  - Automatic `Mcp-Session-Id` management with transparent re-initialization on session expiry
  - Tools list pagination (`nextCursor`), name sanitization (`mcp_<server>_<tool>`) with collision handling, JSON-Schema cleanup for maximum provider compatibility
  - **Registry cache** (`portable/data/mcp-registry.json`): restarts register tools instantly with zero network; stale caches re-scan in the background
  - Per-server auth (`Authorization`) and custom headers via `portable/mcp.json` (advanced) or `JINX_MCP_SERVERS` + `JINX_MCP_AUTH_<NAME>` (simple)
  - Meta tools for the model: `mcp_servers` (status) and `mcp_refresh` (re-scan after config edits)
  - Safety rails: 48 KB result cap, 300-tool cap, per-request timeouts, dead-server isolation, secrets never logged
- **Offline test suite** (`test/`, `npm test`):
  - 38 unit checks — transports (JSON/SSE), auth reject/accept, pagination, session-expiry recovery, cache round-trip, redaction, config parsing
  - 11 E2E checks — boots the real engine against mock Telegram API + mock OpenAI-compatible provider + mock MCP server, and asserts the full loop: message → model → `mcp_calc_add(19,23)` → answer "42" delivered
  - Static layer — syntax of all 12 JS files + bundle-wiring verification
- `SECURITY.md` — full threat model including the MCP trust boundary
- `docs/MCP.md` — Persian MCP guide (setup, auth, mcp.json, env knobs, troubleshooting)
- `portable/mcp.json.example` — advanced config sample
- `check.js` now verifies: MCP bridge present, bundle MCP-wired, and per-server `initialize` + `tools/list` connectivity with tool counts

### Changed

- `package.json` → 2.0.0, description mentions MCP, `test` script, new keywords (`mcp`, `model-context-protocol`, `mcp-client`)
- `app.js` boot banner reports the MCP bridge and points to `docs/MCP.md`
- README: MCP badge + section, honest comparison table (vs OpenClaw / Hermes / E2B), "Tested like it matters" section, updated layout & security notes
- `.env.example` — full MCP configuration block

### Engine bundle

- `dist/portable.cjs` carries a 486-byte, byte-precise hook after tool initialization that loads `mcp-bridge.cjs`. Failure to load is non-fatal by design: the agent keeps every built-in capability. All other bytes identical to v1.0.0's engine (9.3.0-oss).

### Compatibility

- Drop-in upgrade from v1.0.0: replace `app.js`, `check.js`, `dist/portable.cjs` and add `mcp-bridge.cjs`; `portable/` (data + config) untouched. No MCP configured? Zero behavior change.

## v1.0.0 — first public release (2026-11-18)

- One-zip deploy to shared hosting (cPanel/CGI), Passenger, or VPS
- 24/7 Telegram agent: 60+ tools, 20 research engines, QuickJS/WASM sandbox, virtual browser, per-chat memory, scheduling, sub-agents, skills
- Any OpenAI-compatible provider, one-time web wizard, web admin panel
- Zero build step, zero npm install, zero telemetry
