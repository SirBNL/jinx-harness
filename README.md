<div align="center">

<img src="assets/logo.svg" width="150" alt="Jinx Harness logo"/>

# Jinx Harness

## ⚡ Give any model hands.

**A 24/7 AI assistant that lives in your Telegram, runs on your own hosting, and doesn't just chat — it gets things done.**

[![Release](https://img.shields.io/github/v/release/SirBNL/jinx-harness?style=flat-square&label=release)](../../releases/latest)
[![Stars](https://img.shields.io/github/stars/SirBNL/jinx-harness?style=flat-square&color=ffdd00)](../../stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-3da639?style=flat-square)](LICENSE)
[![Build step](https://img.shields.io/badge/build%20step-0-00ADD8?style=flat-square)](#install-in-3-steps--no-skills-required)
[![Deploy](https://img.shields.io/badge/deploy-upload--only-ff6b35?style=flat-square)](#install-in-3-steps--no-skills-required)
[![Provider](https://img.shields.io/badge/provider-bring%20your%20own-8e44ad?style=flat-square)](#which-ai-should-i-plug-in)
[![Tools](https://img.shields.io/badge/tools-60%2B-e74c3c?style=flat-square)](#the-toolbox)

[⬇️ **Download**](../../releases/latest) · [🚀 3-step install](#install-in-3-steps--no-skills-required) · [💬 What it can do](#it-doesnt-just-chat-it-works) · **[🇮🇷 فارسی](#فارسی--خلاصه-برای-کاربر-عادی)**

**⭐ Star this repo if it saves you a subscription — stars keep open-source engines running.**

</div>

---

<a id="فارسی--خلاصه-برای-کاربر-عادی"></a>

## 🇮🇷 فارسی — خلاصه برای کاربر عادی

**جینکس هارنس یعنی: یک دستیار هوش مصنوعی همیشگی روی تلگرام، روی هاست خودت، با کلید خودت.**

- 💬 بهش پیام می‌دی مثل یک آدم — **کار انجام می‌ده، نه فقط حرف می‌زنه**
- 🔍 خودش تحقیق می‌کنه (۲۰ موتور جست‌وجو)، گزارش می‌نویسه، فایل می‌سازه
- 🧪 کد می‌نویسه، داخل سندباکس اجرا می‌کنه، خطا رو می‌بینه، درستش می‌کنه
- ⏰ «هر روز ساعت ۸ اخبار AI رو بفرست» — خودش کار زمان‌بندی‌شده می‌سازه و تا همیشه اجراش می‌کنه
- 🧠 حافظه داره — چیزی که ماه پیش گفتی یادش می‌مونه
- 📧 (اختیاری) جیمیلت رو می‌خونه، درایوت رو مدیریت می‌کنه، تقویمت رو می‌چینه
- 💰 **بدون اشتراک ماهانه** — فقط هزینهٔ مدل AI که خودت انتخاب می‌کنی؛ حتی Ollama رایگانِ روی کامپیوتر خودت
- 📦 نصب = آپلود یک زیپ در سی‌پنل + باز کردن یک لینک + پر کردن یک فرم. **تمام.**
- 🔒 دیتای تو، کلید تو، برند تو — هیچ سرویس واسطی در کار نیست

راهنمای کامل فارسی: **[README-FA.md](README-FA.md)** — ادامه به انگلیسی:

---

<a id="it-doesnt-just-chat-it-works"></a>

## 💬 It doesn't just chat. It works.

You've met chatbots. They answer… and that's the whole show.

Jinx Harness is the other kind — an assistant with hands. You talk to it on Telegram like texting a colleague, and it goes off and *does* things:

| You say | It does |
|---|---|
| *"Research this topic and write me a full report"* | Searches up to 20 engines, reads the sources, writes the report, saves it as a file |
| *"Every morning at 8, send me the top AI news"* | Creates the scheduled job itself — then runs it daily, forever, on your server |
| *"This code throws an error — fix it"* | Runs it in a sealed sandbox, sees the error, fixes it, tests it again |
| *"What did I ask you about last month?"* | Remembers. Per-chat memory, ranked by importance |
| *"Summarize my unread Gmail"* | Reads it and summarizes — through **your own** Google account, with your consent* |
| *"Remind me Friday, 6 pm"* | It simply will. It runs 24/7 — it never sleeps, never forgets |

No *"I'm just a language model, I can't do that."* That sentence doesn't exist here.

> \* Gmail / Drive / Calendar are optional — connected through your own OAuth app, only if you turn them on.

<a id="its-yours-all-of-it"></a>

## 🫵 It's yours. All of it.

| The usual AI apps | Jinx Harness |
|---|---|
| Monthly subscription | **$0 — forever.** You pay only your AI provider, directly |
| Your conversations on their servers | **Your server, one SQLite file.** Copy it, back it up, delete it — it's a file |
| Their brand, their rate limits | **Your brand** — name it, style it, give it a personality |
| They can raise prices or shut down | **Your copy runs as long as your hosting runs** |
| A chat window is all you get | Telegram bot + web admin panel + 60+ tools |

And no, it doesn't phone home: no analytics, no trackers, no "anonymous statistics". The AI calls exactly the one endpoint *you* configure — and nothing else, ever.

<a id="install-in-3-steps--no-skills-required"></a>

## 🚀 Install in 3 steps — no skills required

> **If you can upload a photo and fill in a form, you can run this.**

**Step 1 — Upload.** Download `jinx-harness-v1.0.0.zip` from
[**Releases**](../../releases/latest). In your hosting control panel
(cPanel → *File Manager*), upload it into `public_html` and click **Extract**.

**Step 2 — Open the link.** Visit `https://your-site.com/jinx-harness/`.
After a few seconds, the setup wizard appears.

**Step 3 — Fill one form.**
- Telegram bot token — free from [@BotFather](https://t.me/BotFather); the wizard tests it live while you watch
- Your AI provider — base URL + key + model, tested live, models auto-listed
- A name and personality for your assistant

Press **Create & start** — your assistant is alive, and the one-time wizard locks itself forever.

The admin panel opens at `https://your-site.com/jinx-harness/admin?t=…` (the token is shown once at the end of the wizard).

No SSH. No command line. No Docker. No DevOps. Any ordinary cPanel hosting works — this thing was *engineered* to live there. (VPS? Docker? systemd? Also fine — see [Plan B / C](#plan-b--plan-c).)

| If something looks off | The fix |
|---|---|
| `500 Internal Server Error` | File Manager → right-click `index.cgi` → *Change Permissions* → **755** |
| "Node.js not found" page | Ask your host to enable the Node.js Selector, or upload `node.tar.xz` — [instructions](#where-does-nodejs-come-from) appear automatically |
| 502 gateway page | Read `portable/data/logs/cgi-boot.log`; port conflict → set `PORTABLE_PORT` in `portable/.env` |
| Everything green, bot silent | Send it a message; check `/health`; read `portable/data/logs/bot-DATE.log` |

<a id="which-ai-should-i-plug-in"></a>

## 🧠 Which AI should I plug in?

Whatever speaks the OpenAI format — which is nearly everyone. Swap anytime from the web panel, no restart:

| You want | Plug in | Why |
|---|---|---|
| The classic | OpenAI · `gpt-4o-mini` | Solid all-rounder |
| Best price/performance | DeepSeek · `deepseek-chat` | Cheap, strong at code |
| Free and fast | Groq · `llama-3.3-70b-versatile` | Generous free tier |
| One key, hundreds of models | OpenRouter | Try any model, any day |
| 100% free and private | Ollama, on your own PC | No internet needed at all |

There is **no default provider and no preferred vendor** — the key never leaves your server. Full list and guide: [`docs/PROVIDERS.md`](docs/PROVIDERS.md).

<a id="the-numbers"></a>

## 📊 The numbers

For those who scroll straight past the marketing:

| | |
|---|---|
| Tools the assistant can use | **60+** |
| Research / search engines | **20** — 17 work with **zero** API keys |
| Steps it can take per request | **40**, with crash-resume (a crash costs one checkpoint, not the task) |
| Built-in skill packs | **29** — research, article writing, channel governance… |
| Setup required on the host | **0 packages, 0 build steps** |
| Telemetry / trackers / default keys | **none / none / none** |
| License | **MIT** — free forever, including commercial use |

**Like where this is going? [Star it](../../stargazers) — it genuinely helps.**

## Why "harness"?

A harness is the machinery that turns raw power into directed work. It doesn't care which horse you strap in.

The model is the horse — you choose it, feed it, and can swap it any day. Jinx Harness is everything else: the tools, the memory, the scheduler, the browser, the sandbox, the admin panel, and the survival instincts for cheap hosting.

Models get replaced every quarter. **The harness endures.**

---

# 🧰 Deep dive — for the technically curious

*Everything below is for people who read changelogs for fun. Everyone else: the three steps above are all you'll ever need.*

## Everything in the box

| | |
|---|---|
| **Agentic loop** | Up to **40 tool iterations per turn**, with checkpoint/resume — crash mid-task and it picks up where it died |
| **Sub-agents** | `delegate` spawns focused child agents with their own budget, for research and coding side-quests |
| **60+ tools** | Research, browsing, sandboxed code, files, data, scheduling, messaging, Google suite, skills… full catalog below |
| **20 research engines** | 17 keyless: Wikipedia, Bing (+News), Google News, DuckDuckGo (html/lite), Brave, Mojeek, SearXNG, Stack Overflow, GitHub, Hacker News, arXiv, Crossref, Semantic Scholar, Openverse, Wikimedia Commons — premium (Tavily, Serper, Exa, Brave-API) activate by pasting a key |
| **Real code sandbox** | `run_js` executes in an actual **QuickJS/WASM** virtual machine, plus `run_tests` and `run_project` |
| **Virtual browser** | `browser_navigate`, `browser_click`, `browser_type`, `browser_scroll`, whole-site crawling |
| **Memory** | Per-chat and per-user facts, importance-ranked, plus workspace projects with real files on disk |
| **Scheduling** | Cron-style jobs, reminders, digests, autonomous mode, channel posting — a genuine 24/7 engine |
| **Rich messaging** | Footnotes, collapsible sections, interactive buttons, task lists, galleries, live localized time |
| **Google suite** | Gmail (read / search / send), Drive (read / search / upload), Calendar — through your own OAuth app |
| **Autonomy control** | Three tool modes: `full`, `ask` (confirm every action), `smart` middle ground |
| **Web admin panel** | Live stats, providers, backups, health tests, settings — protected by a 64-hex token |
| **Reliability** | SQLite (WAL), daily backups (7 kept), persistent polling offset, anti-crash guard, zombie watchdog |

<a id="the-toolbox"></a>

## The toolbox

| Group | Tools |
|---|---|
| **Research** | 20 engines — see table above |
| **Virtual browser** | `browser_navigate`, `browser_click`, `browser_type`, `browser_scroll`, `crawl_site` |
| **Code** | `run_js` (QuickJS/WASM sandbox), `run_tests`, `run_project` |
| **Files & projects** | `create_file`, `write_files`, `move_file`, `delete_files`, `project_create` |
| **Data & memory** | `remember` (importance-ranked facts), SQL over its own database, `save_pack` |
| **Messaging** | `send_message`, `send_photo`, `send_file`, `send_widget`, `dm_send`, `channel_action` (chat/channel governance) |
| **Scheduling** | `create_job`, `cancel_task`, `set_reminder`, digests, autonomous mode |
| **Google suite** | `gmail_read`, `gmail_search`, `gmail_send`, `drive_read`, `drive_search`, `drive_upload`, `calendar_create`, `calendar_events` |
| **Agent ops** | `delegate`, `ask_user`, approval flows, `http_request`, `image_gen`, `install_skill` / `uninstall_skill`, `bind_emoji` |
| **Skills** | 29 built-in skill packs, installable and removable at runtime |

Bot commands for humans: `/help` `/status` `/memory` `/tasks` `/about` `/cancel` `/stop` — plus `/admin` for the panel link.

## Engine specifications

| Spec | Value |
|---|---|
| Tool-loop depth | 40 iterations per turn |
| Crash recovery | checkpoint/resume (every 30 min by default) |
| Hard run deadline | 6 hours per task (configurable) |
| Outbound subrequest cap | 1,000,000 per run (configurable) |
| Engine size | one ~1.2 MB prebuilt file + 492 KB QuickJS/WASM |
| `npm install` on the host | 0 packages (one optional fallback: `sql.js` on Node 18) |
| Runtime | Node.js 18+ (22+ recommended) |

## How it survives shared hosting

Most software treats shared hosting as a place software goes to die. Jinx Harness treats it as a design target — and fights back.

```
 visitor ──► .htaccess ──► index.cgi ──► gateway.cjs
             (the only      (sh)          │  finds Node (5 sources),
              door in                      │  boots the daemon, proxies
              the repo)                   ▼
                                        app.js
                            no config? ──┴── configured
                                  ▼              ▼
                         setup-server.cjs   dist/portable.cjs  (the engine)
                         (one-time web           │
                          wizard)       ┌────────┴─────────┐
                                       │ 40-step tool loop│
                                       │ checkpoint/resume│
                                       │ sub-agents       │
                                       │ 60+ tools        │
                                       │ QuickJS sandbox  │
                                       └────────┬─────────┘
                                                ▼
                              your provider — any OpenAI-compatible /v1
```

- **Detached boot.** Apache runs `index.cgi` under your account (suexec); the gateway spawns the daemon with `setsid`, so it survives the CGI request that started it. A single-instance lock prevents double boots.
- **Deterministic ports.** The daemon's port is derived from an FNV-1a hash of your home directory (41000–42999) and persisted — two installs on one account never collide.
- **It survives memory-capped hosts.** Some CloudLinux boxes cap virtual memory so hard that Node's own HTTP engine (undici / llhttp-wasm) cannot reserve WASM memory and dies on *every* `fetch()`. Jinx Harness detects this at boot and swaps in a pure-JS fetch implementation (streams, redirects, gzip, SSE) — and even defuses the one scary unhandled rejection it would otherwise log. The `run_js` sandbox likewise falls back from QuickJS/WASM to a built-in interpreter. Nothing is lost, the logs stay clean.
- **Watchdog + keepalive.** One cron job every 5 minutes (`php keepalive.php`, or an external `curl`) pokes the daemon. The watchdog detects zombie states — process alive, Telegram polling dead — and reboots them.

### <a id="where-does-nodejs-come-from"></a>Where does Node.js come from?

The launcher `index.cgi` looks for a runtime in this order:

1. `bin/node` — self-extracted from `node.tar.xz` if you upload one
2. `~/bin/node` · 3. `node` in the account PATH
4. **CloudLinux Node.js Selector** paths (`/opt/alt/alt-nodejs*/v*/bin/node`) — present on most cPanel hosts even if you never created a Node app
5. nvm installs, then common system paths

If nothing is found you get a friendly page explaining the two fixes: ask the host to enable the Node.js Selector, or upload `node.tar.xz` (the glibc-2.17 build from [unofficial-builds.nodejs.org](https://unofficial-builds.nodejs.org/download/release/), renamed) next to `index.cgi` — it self-extracts and boots.

## Configuration

Everything lives in `portable/.env` — written by the wizard, editable by hand, fully documented in [`portable/.env.example`](portable/.env.example). Highlights:

```ini
BOT_TOKEN=…                      # @BotFather
ADMIN_ID=…                       # your numeric Telegram id
WEBHOOK_SECRET=…                 # admin panel token

JINX_BASE_URL=https://api.openai.com/v1   # your provider
JINX_API_KEY=sk-…
JINX_MODEL=gpt-4o-mini

JINX_BRAND_NAME=Jinx Harness     # how the agent introduces itself
JINX_MAKER_NAME=                 # optional "made by …"
JINX_PERSONA=                    # optional full custom system prompt
```

**Factory reset:** delete `portable/.env` (and `portable/data/` if you also want the memory gone) — the one-time wizard unlocks again on the next visit.

**Update to a newer release:** replace `app.js`, `check.js`, `gateway.cjs`, `setup-server.cjs`, `fetch-shim.cjs` and `dist/` — `portable/` (your data and configuration) stays untouched.

## Security model

- `portable/` (config, SQLite, logs, backups) and every source file are denied to the web by `.htaccess`; the **only** public entry is `index.cgi`.
- The daemon binds `127.0.0.1` only. In CGI mode a per-install setup key protects the wizard from neighbours on shared hosts; the key file is deleted after setup.
- The admin panel requires a 64-hex token (`WEBHOOK_SECRET`) — rotate it any time.
- No analytics, no update checks, no default endpoints. Search tools call public engines; the AI calls exactly the base URL you configured.
- If your host ignores `.htaccess`, install the folder outside `public_html` and use Plan B/C. Never commit `portable/.env`.

<a id="plan-b--plan-c"></a>

## Plan B / Plan C

**Plan B — Passenger (cPanel "Setup Node.js App").** Create the app (Node 22+, any subdomain, startup file **`app.js`**), upload & extract the zip into the application root, open the URL — the same wizard appears. On Node < 22, click *Run NPM Install* once for the `sql.js` fallback engine.

**Plan C — VPS / local / systemd.**

```bash
unzip jinx-harness-v1.0.0.zip -d jinx-harness && cd jinx-harness
node app.js            # no config? the wizard binds 127.0.0.1:<port> — see console
node app.js --check    # pre-flight self-test: files, secrets, Telegram, provider, disk
```

Run it under systemd/supervisor with `Restart=always` for production; it is a single long-lived Node process with SQLite storage.

**Keepalive (shared hosting).** One cron every 5 minutes — cPanel → *Cron Jobs*:
`php /home/USERNAME/public_html/jinx-harness/keepalive.php`
(or from any external cron: `curl -s https://your-site.com/jinx-harness/ >/dev/null`).

## FAQ

**Does it phone home?** No. Zero telemetry, zero default endpoints, zero update checks.

**Can I run several assistants on one host?** Yes — extract each copy into its own folder; ports are derived per-install automatically.

**Why Telegram first?** It is the richest mainstream messaging API (widgets, collapsible sections, footnotes) and it needs no domain or app-store review — perfect for shared hosting. The web admin panel works everywhere regardless.

**The UI is Persian?** Persian-first, by origin — the wizard and admin panel are bilingual, and `DEFAULT_LANG` is a setting (`fa` default, any language the model speaks works in chat). See [`README-FA.md`](README-FA.md).

**Where does my data live?** Flat files under `portable/` on your host: one SQLite database, logs, backups. Yours. Export or delete them in File Manager.

**Cloudflare Workers?** Out of scope for this build: the engine assumes a long-lived process, a real filesystem and SQLite. Workers would need D1/KV and different tool budgets. Cheapest serverless-adjacent path is a small VPS (Plan C).

**I don't trust a prebuilt bundle.** Fair. The wrapper layer — boot, gateway, wizard, self-test, fetch shim, ~everything you interact with — is plain readable JavaScript in this repo. The engine ships as one prebuilt file (`dist/portable.cjs`); the original TypeScript sources of this build are not part of the repository (see provenance below).

## Repository layout & provenance

```
index.cgi           CGI entry (shell) — finds Node, execs gateway.cjs     [755]
gateway.cjs         boots the daemon if needed, reverse-proxies requests
app.js              startup: setup-mode vs full boot, env, fetch-shim hook
setup-server.cjs    the one-time web wizard
check.js            pre-flight self-test  (node app.js --check)
fetch-shim.cjs      pure-JS fetch for memory-capped shared hosts
keepalive.php       cron watchdog (PHP-only hosts)
no-node.html        friendly page when no Node.js runtime is found
dist/portable.cjs   the agent runtime — prebuilt bundle, ~1.2 MB
dist/quickjs-*.wasm real QuickJS engine for the run_js sandbox
portable/           your data: .env, jinx.db, logs, backups  (not in git)
docs/PROVIDERS.md   provider guide (فارسی)
assets/logo.svg     project logo
```

The agent runtime is distributed as a prebuilt CommonJS bundle; the original TypeScript sources of this particular build are not part of this repository. Everything else — the entire wrapper layer listed above — is plain readable JavaScript you can audit line by line.

---

*telegram ai agent · self-hosted llm agent · openai-compatible agent runtime · telegram bot with tools · ai agent for cpanel & shared hosting · quickjs sandbox · بات هوش مصنوعی تلگرام · ایجنت شخصی تلگرام · هوش مصنوعی روی هاست اشتراکی*

## License

[MIT](LICENSE) — strap in, go anywhere.
