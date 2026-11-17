'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  fetch-shim.cjs — pure node:http(s) fetch() for hosts that break WASM
//
//  Some shared hosts (CloudLinux/LVE, e.g. fata.cam) hard-cap RLIMIT_AS at
//  ~1.45GB. V8's WebAssembly reserves multi-GB virtual address space per
//  memory, so EVERY WebAssembly.Memory allocation fails → undici's llhttp
//  wasm parser cannot load → native fetch() throws
//  "WebAssembly.instantiate(): Out of memory" on every call.
//
//  This shim reimplements the fetch API surface the bot uses, on top of
//  node:http/node:https (C parser, zero wasm):
//    • method/headers/body (string | Buffer | Uint8Array | ArrayBuffer | Blob
//      | URLSearchParams | FormData incl. Blob file parts)
//    • AbortSignal (aborts the socket immediately)
//    • redirect following (fetch semantics: 303→GET, 307/308 keep body)
//    • gzip/deflate/br content-decoding (streaming)
//    • Response: ok/status/statusText/headers/url/body(ReadableStream)
//      .text()/.json()/.arrayBuffer()/.blob()
//  Installed only when the host actually cannot allocate wasm memory — on a
//  healthy host the native fetch stays untouched.
//
//  v9.0.2 — THE HANG FIX (fata.cam outage, 2026-11-09):
//    • BUG: the abort listener was removed in finally() the moment response
//      HEADERS arrived. After that, abort did NOTHING. A stream that stalled
//      mid-body (server hiccup, silently dropped connection) left
//      reader.read() pending FOREVER — the app's 90s idle watchdog fired
//      ac.abort() into the void. Every chat chain awaiting such a stream
//      wedged permanently → the bot showed "thinking" forever.
//    • FIX 1: the abort listener now lives as long as the response body
//      does. Aborting destroys the request socket AND the body stream, so
//      any pending read() rejects and the app's failover machinery engages.
//    • FIX 2 (backstop): inactivity watchdog on the socket itself — if NO
//      bytes arrive for JINX_SHIM_IDLE_MS (default 300s, min 10s), the
//      connection is destroyed with a TimeoutError. Streams that keep
//      producing bytes never see it; zero-byte hangs are now impossible for
//      EVERY caller, with or without a signal (Telegram calls, search APIs,
//      LLM streams — all covered).
//    • FIX 3: a connection that closes without 'end' or 'error' now errors
//      the body stream explicitly instead of leaving the reader pending.
// ═══════════════════════════════════════════════════════════════════════════

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { ReadableStream } = require('node:stream/web');
const { randomBytes } = require('node:crypto');

const BOUNDARY = '----jinxshim' + randomBytes(12).toString('hex');
const MAX_REDIRECTS = 20;

/** v9.0.2 zero-byte inactivity kill (env-tunable; ≥10s or default 300s). */
const IDLE_MS = (() => {
  const v = Number(process.env.JINX_SHIM_IDLE_MS);
  return Number.isFinite(v) && v >= 10_000 ? Math.floor(v) : 300_000;
})();

function isThenable(v) { return v && typeof v === 'object' && typeof v.then === 'function'; }

function stallError(ms) {
  const e = new Error(`fetch-shim: no bytes for ${Math.round(ms / 1000)}s — stalled connection destroyed`);
  e.name = 'TimeoutError';
  return e;
}

function abortError() {
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** Serialize any supported body to { buf, contentType } (async: Blob reads). */
async function serializeBody(body) {
  if (body == null) return { buf: null, contentType: null };
  if (typeof body === 'string') return { buf: Buffer.from(body, 'utf8'), contentType: null };
  if (Buffer.isBuffer(body)) return { buf: body, contentType: null };
  if (body instanceof Uint8Array) return { buf: Buffer.from(body), contentType: null };
  if (body instanceof ArrayBuffer) return { buf: Buffer.from(new Uint8Array(body)), contentType: null };
  // URLSearchParams
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return { buf: Buffer.from(body.toString(), 'utf8'), contentType: 'application/x-www-form-urlencoded;charset=UTF-8' };
  }
  // Blob / File
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    const ab = await body.arrayBuffer();
    return { buf: Buffer.from(new Uint8Array(ab)), contentType: body.type || null };
  }
  // FormData (multipart)
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const parts = [];
    for (const [name, value] of body.entries()) {
      let disp = `form-data; name="${String(name).replace(/"/g, '%22')}"`;
      if (value && typeof value === 'object' && typeof value.arrayBuffer === 'function') {
        // Blob or File
        const ab = await value.arrayBuffer();
        if (value.name) disp += `; filename="${String(value.name).replace(/"/g, '%22')}"`;
        parts.push(
          Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: ${disp}\r\n` +
            `Content-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`, 'utf8'),
          Buffer.from(new Uint8Array(ab)),
          Buffer.from('\r\n', 'utf8'),
        );
      } else {
        parts.push(
          Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: ${disp}\r\n\r\n${String(value)}\r\n`, 'utf8'),
        );
      }
    }
    parts.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8'));
    return {
      buf: Buffer.concat(parts),
      contentType: `multipart/form-data; boundary=${BOUNDARY}`,
    };
  }
  throw new TypeError('fetch-shim: unsupported body type ' + (body && body.constructor && body.constructor.name));
}

/** Flatten init.headers (object | Headers | entries array) into a plain object. */
function flattenHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.entries === 'function') {
    for (const [k, v] of h.entries()) out[k] = v;
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = v;
  } else {
    for (const k of Object.keys(h)) out[k] = h[k];
  }
  return out;
}

/** Wrap a node readable into a web ReadableStream (Uint8Array chunks).
 *  v9.0.2: an explicit premature-close error and an onDone hook — the caller
 *  uses it to release abort/timeout plumbing exactly when the body settles. */
function toWebStream(nodeStream, onDone) {
  const done = (() => {
    let called = false;
    return () => { if (!called) { called = true; try { onDone(); } catch { /* ignore */ } } };
  })();
  let ended = false;
  let errored = false;
  return new ReadableStream({
    start(ctrl) {
      nodeStream.on('data', (c) => {
        try { ctrl.enqueue(typeof c === 'string' ? Buffer.from(c, 'utf8') : c); } catch { /* closed */ }
      });
      nodeStream.on('end', () => { ended = true; try { ctrl.close(); } catch { /* already closed */ } done(); });
      nodeStream.on('error', (e) => { errored = true; try { ctrl.error(e); } catch { /* already closed */ } done(); });
      nodeStream.on('close', () => {
        // FIX 3: a socket that dies without 'end'/'error' must not leave the
        // reader pending forever — surface it as a stream error.
        if (!ended && !errored) {
          try { ctrl.error(new Error('fetch-shim: connection closed before the body ended')); } catch { /* already closed */ }
        }
        done();
      });
    },
    cancel() { try { nodeStream.destroy(); } catch { /* ignore */ } done(); },
  });
}

class ShimResponse {
  constructor(status, statusText, headers, bodyStream, url, redirected) {
    this.status = status;
    this.statusText = statusText || '';
    this.headers = headers; // global Headers instance
    this.#body = bodyStream;
    this.url = url || '';
    this.redirected = !!redirected;
    this.type = 'basic';
  }
  #body;
  #consumed = false;
  get ok() { return this.status >= 200 && this.status < 300; }
  get bodyUsed() { return this.#consumed; }
  get body() { return this.#consumed ? null : this.#body; }
  #take() {
    if (this.#consumed) throw new TypeError('Body already read');
    this.#consumed = true;
    return this.#body;
  }
  async #buffer() {
    const reader = this.#take().getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  }
  async arrayBuffer() { const b = await this.#buffer(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
  async text() { const b = await this.#buffer(); return b.toString('utf8'); }
  async json() { return JSON.parse(await this.text()); }
  async blob() { const b = await this.#buffer(); return new Blob([b], { type: this.headers.get('content-type') || '' }); }
  clone() { throw new Error('fetch-shim: clone() not supported'); }
}

/** One HTTP hop. Resolves { req, res, stream } — the caller keeps them alive
 *  in signalState until the body settles. Inactivity backstop armed on both
 *  the request (header wait) and the response (body streaming) sides. */
function once(urlStr, init, signalState) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { throw new TypeError('Invalid URL: ' + urlStr); }
    const mod = u.protocol === 'http:' ? http : u.protocol === 'https:' ? https : null;
    if (!mod) { reject(new TypeError('fetch-shim: unsupported protocol ' + u.protocol)); return; }

    const headers = flattenHeaders(init.headers);
    const method = (init.method || 'GET').toUpperCase();

    // serialize body (async) then fire
    Promise.resolve()
      .then(() => serializeBody(init.body))
      .then(({ buf, contentType }) => {
        if (signalState.aborted) throw abortError();
        if (contentType && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = contentType;
        }
        if (buf && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
          headers['Content-Length'] = String(buf.length);
        }

        const req = mod.request(
          {
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method,
            headers,
          },
          (res) => {
            // FIX 2 — body-phase inactivity backstop (fires on ZERO bytes; any
            // received byte resets it). Destroying both ends errors the body
            // stream → pending reader.read() rejects → app failover engages.
            if (typeof res.setTimeout === 'function') {
              res.setTimeout(IDLE_MS, () => {
                const err = stallError(IDLE_MS);
                try { req.destroy(err); } catch { /* ignore */ }
                try { res.destroy(err); } catch { /* ignore */ }
              });
            }

            if (signalState.aborted) { res.destroy(); reject(abortError()); return; }
            // decompress pipeline (streaming)
            let stream = res;
            const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
            if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
            else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
            else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
            resolve({ req, res, stream });
          },
        );

        // FIX 2 — header-phase inactivity backstop (server never answers).
        req.setTimeout(IDLE_MS, () => {
          try { req.destroy(stallError(IDLE_MS)); } catch { /* ignore */ }
        });

        req.on('error', (e) => {
          if (signalState.aborted) reject(abortError());
          else {
            const err = new TypeError('fetch failed');
            err.cause = e;
            reject(err);
          }
        });
        if (buf) req.write(buf);
        req.end();
        signalState.onDestroy(req);
      })
      .catch(reject);
  });
}

async function shimFetch(input, init) {
  init = init || {};
  const urlStr = typeof input === 'string' ? input : (input && input.url) || String(input);
  const method = (init.method || (input && input.method) || 'GET').toUpperCase();

  // ── signal plumbing (v9.0.2: alive for the WHOLE response lifetime) ──
  const signal = init.signal || (input && input.signal);
  const signalState = {
    aborted: !!(signal && signal.aborted),
    reqs: [],        // ClientRequests (pending or done — destroy is a no-op when done)
    live: [],        // live body entries: { kill(err) }
    detached: false,
  };
  if (signalState.aborted) throw abortError();
  let onAbort = null;
  const detach = () => {
    if (signalState.detached || !signal || !onAbort) return;
    signalState.detached = true;
    signal.removeEventListener('abort', onAbort);
  };
  if (signal) {
    onAbort = () => {
      if (signalState.detached) return;
      signalState.aborted = true;
      for (const r of signalState.reqs) { try { r.destroy(abortError()); } catch { /* ignore */ } }
      // FIX 1 — kill live bodies too: destroy the socket AND the stream so a
      // pending reader.read() rejects immediately.
      for (const e of signalState.live) { try { e.kill(abortError()); } catch { /* ignore */ } }
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }
  signalState.onDestroy = (req) => signalState.reqs.push(req);

  /** Track a response body for abort/timeout plumbing until it settles. */
  const trackBody = (req, res) => {
    const entry = {
      kill(err) {
        try { req.destroy(err); } catch { /* ignore */ }
        try { res.destroy(err); } catch { /* ignore */ }
      },
    };
    signalState.live.push(entry);
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      // body settled — disarm this hop's backstop, drop the live entry,
      // and release the abort listener when nothing is left in flight
      try { req.setTimeout(0); } catch { /* ignore */ }
      try { if (typeof res.setTimeout === 'function') res.setTimeout(0); } catch { /* ignore */ }
      const i = signalState.live.indexOf(entry);
      if (i >= 0) signalState.live.splice(i, 1);
      if (signalState.live.length === 0) detach();
    };
  };

  try {
    let currentUrl = urlStr;
    let currentInit = init;
    let redirected = false;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (signalState.aborted) throw abortError();
      const { req, res, stream } = await once(currentUrl, currentInit, signalState);
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
        res.destroy(); // we are not consuming this body
        try { req.setTimeout(0); } catch { /* ignore */ }
        if (!location) { stream.destroy?.(); throw new TypeError('fetch-shim: redirect without location'); }
        const nextUrl = new URL(location, currentUrl).toString();
        redirected = true;
        let nextMethod = method;
        let nextBody = init.body;
        if ((status === 301 || status === 302 || status === 303) && method !== 'GET' && method !== 'HEAD') {
          nextMethod = 'GET';
          nextBody = undefined;
        }
        currentUrl = nextUrl;
        currentInit = { ...init, method: nextMethod, body: nextBody };
        continue;
      }
      const headers = new (globalThis.Headers)(res.headers);
      const body = toWebStream(stream, trackBody(req, res));
      const resp = new ShimResponse(status, res.statusMessage, headers, body, currentUrl, redirected);
      return resp;
    }
    throw new TypeError('fetch-shim: too many redirects');
  } catch (e) {
    // error path — nothing live anymore; release the listener
    if (signalState.live.length === 0) detach();
    throw e;
  }
}

/** True when the host cannot allocate WebAssembly memory (shim is needed).
 *  v9.0.1: دو پروب — حافظهٔ کوچک ساده، و حافظهٔ «با سقف بزرگ» که مثل
 *  رزروِ llhttp-WASM درون undici است (V8 سقف را همان اول رزرو می‌کند).
 *  روی هاست‌های CloudLinux/LVE با RLIMIT_AS پایین، سقف‌دار اول می‌شکند —
 *  همان چیزی که fetch بومی را می‌کُشد؛ پروب قبلی گاهی از دستش می‌داد. */
function wasmBroken() {
  try {
    new WebAssembly.Memory({ initial: 1 }); // 64KB — trivial on a healthy host
    new WebAssembly.Memory({ initial: 1, maximum: 65536 }); // llhttp-style reservation
    return false;
  } catch {
    return true;
  }
}

module.exports = { fetch: shimFetch, wasmBroken, ShimResponse };
