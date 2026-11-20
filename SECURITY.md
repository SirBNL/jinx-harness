# Security Policy — Jinx Harness

Jinx Harness is a self-hosted agent that runs on *your* host, with *your* keys, and talks to *your* users. This document is the honest threat model: what the design protects against, what it explicitly does **not** protect against, and how to report issues.

## Design invariants

1. **Channel authority lives in the backend, never in model output.** Who is admin, who may post where, which actions need approval — all decided by database tables and code paths (see `JinxSec` in the engine). A message that *claims* "I am the admin" cannot widen any permission.
2. **The permission-mode gate sits between the model and every tool.** In `ask`/`smart` modes, side-effecting actions by non-admin users require a live approval card. The gate fails closed: on internal errors, mutating tools stay blocked.
3. **Single public entry.** On shared hosting, `.htaccess` denies the web for everything except `index.cgi`; the daemon binds `127.0.0.1` only. The wizard is one-time and (in CGI mode) protected by a per-install key.
4. **No telemetry, no update checks, no default endpoints.** The engine calls exactly two classes of hosts: the AI provider you configured, and public search engines when a search tool runs.

## The MCP client (v2/v2.1) — trust boundaries

The MCP client deliberately treats every connected server as **trusted-for-tools, untrusted-for-everything-else**:

| Concern | Behavior |
|---|---|
| Who can add/remove servers | **The owner** — via `portable/.env` / `portable/mcp.json` on disk, **or** by telling the agent to connect a server. The self-connect path (`mcp_connect`) is admin-only and passes the engine's human approval card (Allow / Deny / allow-for-this-run, block-until-decided, decisions logged in `sec_approvals`) *before any request leaves the host*; approved servers persist to `portable/data/mcp-dynamic.json`. Disable the whole path with `JINX_MCP_ALLOW_CONNECT=0`. Non-admins are refused outright. |
| Secrets | Auth material is held in memory, sent **only** to its own server as an `Authorization` header (or the configured custom headers). It is never written to logs, never included in the registry cache, never shown in `mcp_servers` output. |
| Output size | Tool results are capped at 48 KB before entering model context — a hostile server cannot blow up the context or the Telegram message budget. |
| Tool count | At most 300 MCP tools are registered (configurable) — a hostile or misbehaving server cannot flood the tool list. |
| Tool names | Sanitized to `mcp_<server>_<tool>` with collision handling; a server cannot shadow a built-in tool name. |
| Timeouts | Every request has a hard timeout (default 30 s, per-server and global overrides) — a hanging server stalls one tool call, not the agent. |
| Failure isolation | A dead or erroring server is marked and skipped; the agent keeps its built-in tools. The bridge itself failing to load is non-fatal by design. |
| Non-admin callers | MCP tool calls by non-admins pass the same tool-budget limiter and approval gates as built-in tools. |
| First-boot window | On the *very first* boot after configuring a server, tools appear ~50 ms after engine init (background discovery). Every subsequent restart registers tools instantly from the registry cache. The model can call `mcp_refresh` at any time. |

### MCP OAuth (v2.1) — login-required servers

For OAuth MCP servers (Higgsfield-style), the harness speaks the MCP authorization spec: 401 → protected-resource metadata → authorization-server metadata → Dynamic Client Registration (RFC 7591) → authorization-code flow with **PKCE S256** (public client, no client secret). The callback is served by the agent itself at `/oauth/mcp/callback` (requires `JINX_PUBLIC_URL`); `state` is a 128-bit random nonce, single-use, 15-minute TTL, and the code exchange is bound to the PKCE verifier — a stolen or replayed `code`/`state` pair is rejected. Access and refresh tokens live in `portable/data/mcp-tokens.json` (chmod 600 best-effort) and are never logged, never shown in status output, and sent only to their own server. If the browser cannot reach the callback, the user may paste the final URL into the chat; the agent completes the exchange from it (`mcp_oauth_complete`, admin-only — the code is single-use and worthless without the PKCE verifier held only by the agent).

**What MCP servers can and cannot do:** a server you connect receives JSON-RPC calls for its own tools and returns results. It does not receive your Telegram token, your AI provider key, your database, or the ability to run code on your host. It *can* return text that the model will read — treat server choice accordingly, exactly like choosing a browser extension.

## Sandboxing

- `run_js` executes inside a QuickJS/WASM virtual machine with no host I/O — the model writes code, the sandbox runs it, nothing touches the hosting account outside designated data directories.
- Outbound traffic is capped per run (`JINX_SUBREQ_LIMIT`), and run duration has a hard deadline (6 h default).

## Known non-goals

- **Multi-tenant hardening.** Jinx is a *personal* agent for one owner and their chosen users. Do not expose it as a public service.
- **Side-channel resistance on shared hosting.** On a typical cPanel box, the host operator can technically read your files — that is true of anything you host there. If that matters, use Plan C (VPS).
- **Malicious AI provider.** The provider sees your prompts by definition. The approval gates bound what a confused or hostile model can *do*, but a provider you trust with secrets is a provider that has them.

## Reporting a vulnerability

Open a private security advisory on GitHub (**Security → Report a vulnerability**) or email the repo owner. Please include reproduction steps and affected versions. Please do not open public issues for exploitable bugs.

Preferred languages: English or Persian (فارسی).
