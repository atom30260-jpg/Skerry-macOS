/**
 * Official-CLI impersonation for Claude and Codex OAuth only.
 * Claude Code 2.1.220 Axios control plane: HTTP/1.1, no ALPN, axios/1.15.2.
 * Codex CLI identity: HTTP/1.1, no ALPN, official rust CLI originator + User-Agent.
 * Grok and Gemini keep the default fetch stack.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import { promisify } from "node:util";

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotliDecompress = promisify(zlib.brotliDecompress);

export const CLAUDE_OAUTH_USER_AGENT = "axios/1.15.2";
export const CLAUDE_OAUTH_ACCEPT = "application/json, text/plain, */*";
export const CLAUDE_OAUTH_ACCEPT_ENCODING = "gzip, compress, deflate, br";

/** Wire order from Claude Code 2.1.220 Axios token/refresh POSTs. */
export const CLAUDE_OAUTH_HEADER_ORDER = Object.freeze([
  "Accept",
  "Content-Type",
  "User-Agent",
  "Content-Length",
  "Accept-Encoding",
  "Host",
  "Connection",
]);

/** Wire order from Claude Code Axios GET /api/oauth/profile and /api/oauth/claude_cli/roles. */
export const CLAUDE_OAUTH_INSPECT_HEADER_ORDER = Object.freeze([
  "Accept",
  "Content-Type",
  "Authorization",
  "Cache-Control",
  "User-Agent",
  "Accept-Encoding",
  "Host",
  "Connection",
]);

export const CODEX_CLI_USER_AGENT = "codex_cli_rs/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11";
export const CODEX_CLI_ORIGINATOR = "codex_cli_rs";
export const CODEX_OAUTH_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";

export const CODEX_OAUTH_HEADER_ORDER = Object.freeze([
  "Accept",
  "Content-Type",
  "User-Agent",
  "Originator",
  "Content-Length",
  "Host",
  "Connection",
]);

/** OpenSSL names matching CPA claudeOAuthTLSClientHelloSpec cipher suites. */
export const CLAUDE_OAUTH_CIPHERS = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-SHA",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-ECDSA-AES256-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

export const CLAUDE_OAUTH_SIGALGS = [
  "ecdsa_secp256r1_sha256",
  "rsa_pss_rsae_sha256",
  "rsa_pkcs1_sha256",
  "ecdsa_secp384r1_sha384",
  "rsa_pss_rsae_sha384",
  "rsa_pkcs1_sha384",
  "rsa_pss_rsae_sha512",
  "rsa_pkcs1_sha512",
  "rsa_pkcs1_sha1",
].join(":");

export const CLAUDE_OAUTH_ECDH = "X25519:prime256v1:secp384r1";

const agents = new Map();

export function claudeOAuthTlsConnectOptions(overrides = {}) {
  const options = {
    ...overrides,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
    ciphers: CLAUDE_OAUTH_CIPHERS,
    sigalgs: CLAUDE_OAUTH_SIGALGS,
    ecdhCurve: CLAUDE_OAUTH_ECDH,
  };
  delete options.ALPNProtocols;
  return options;
}

export function claudeOAuthRequestHeaders({ contentType } = {}) {
  return {
    Accept: CLAUDE_OAUTH_ACCEPT,
    "Content-Type": contentType || "application/json",
    "User-Agent": CLAUDE_OAUTH_USER_AGENT,
    "Accept-Encoding": CLAUDE_OAUTH_ACCEPT_ENCODING,
    Connection: "close",
  };
}

export function codexOAuthRequestHeaders({ contentType } = {}) {
  return {
    Accept: "application/json",
    "Content-Type": contentType || "application/x-www-form-urlencoded",
    "User-Agent": CODEX_CLI_USER_AGENT,
    Originator: CODEX_CLI_ORIGINATOR,
    Connection: "close",
  };
}

export function extraClaudeOAuthHeaders() {
  return {
    Accept: CLAUDE_OAUTH_ACCEPT,
    "User-Agent": CLAUDE_OAUTH_USER_AGENT,
    "Accept-Encoding": CLAUDE_OAUTH_ACCEPT_ENCODING,
    Connection: "close",
  };
}

export function extraCodexOAuthHeaders() {
  return {
    Accept: "application/json",
    "User-Agent": CODEX_CLI_USER_AGENT,
    Originator: CODEX_CLI_ORIGINATOR,
    Connection: "close",
  };
}

export function headerOrderFor(profile, method, requestTarget) {
  if (profile === "claude-oauth") {
    const target = String(requestTarget || "");
    if (String(method || "").toUpperCase() === "GET"
      && (target.startsWith("/api/oauth/profile") || target.startsWith("/api/oauth/claude_cli/roles"))) {
      return CLAUDE_OAUTH_INSPECT_HEADER_ORDER;
    }
    return CLAUDE_OAUTH_HEADER_ORDER;
  }
  return CODEX_OAUTH_HEADER_ORDER;
}

export function orderHttp1RequestHeaders(headerBlock, orderFor) {
  const text = Buffer.isBuffer(headerBlock) ? headerBlock.toString("latin1") : String(headerBlock);
  const split = text.indexOf("\r\n\r\n");
  const head = split === -1 ? text.replace(/\r\n$/, "") : text.slice(0, split);
  const lines = head.split("\r\n");
  if (lines.length < 2) return Buffer.from(text, "latin1");
  const requestLine = lines[0];
  const headerLines = lines.slice(1).filter((line) => line.length > 0);
  const parts = requestLine.split(" ");
  const order = typeof orderFor === "function"
    ? orderFor(parts[0], parts[1])
    : orderFor;
  if (!order?.length) return Buffer.from(text, "latin1");
  const used = headerLines.map(() => false);
  const ordered = [requestLine];
  for (const name of order) {
    for (let i = 0; i < headerLines.length; i += 1) {
      if (used[i]) continue;
      const colon = headerLines[i].indexOf(":");
      if (colon <= 0) continue;
      if (headerLines[i].slice(0, colon).toLowerCase() !== name.toLowerCase()) continue;
      ordered.push(`${name}${headerLines[i].slice(colon)}`);
      used[i] = true;
    }
  }
  for (let i = 0; i < headerLines.length; i += 1) {
    if (!used[i]) ordered.push(headerLines[i]);
  }
  const rest = split === -1 ? "" : text.slice(split + 4);
  return Buffer.from(`${ordered.join("\r\n")}\r\n\r\n${rest}`, "latin1");
}

function toBuffer(chunk, encoding) {
  if (chunk == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), encoding || "utf8");
}

export function wrapOrderedHeaderSocket(socket, orderFor) {
  const rawWrite = socket.write;
  const rawEnd = socket.end;
  let pending = Buffer.alloc(0);
  let headerDone = false;

  function complete(extra) {
    const buf = extra?.length ? Buffer.concat([pending, extra]) : pending;
    pending = Buffer.alloc(0);
    const idx = buf.indexOf("\r\n\r\n");
    if (idx < 0) return buf;
    return Buffer.concat([
      orderHttp1RequestHeaders(buf.subarray(0, idx + 4), orderFor),
      buf.subarray(idx + 4),
    ]);
  }

  socket.write = function write(chunk, encoding, cb) {
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = undefined;
    }
    if (headerDone || chunk == null || chunk === "") {
      return rawWrite.call(this, chunk, encoding, cb);
    }
    pending = Buffer.concat([pending, toBuffer(chunk, encoding)]);
    if (pending.indexOf("\r\n\r\n") < 0) {
      if (cb) queueMicrotask(cb);
      return true;
    }
    headerDone = true;
    return rawWrite.call(this, complete(), cb);
  };

  socket.end = function end(chunk, encoding, cb) {
    if (typeof chunk === "function") {
      cb = chunk;
      chunk = undefined;
      encoding = undefined;
    } else if (typeof encoding === "function") {
      cb = encoding;
      encoding = undefined;
    }
    if (!headerDone && (pending.length || (chunk != null && chunk !== ""))) {
      headerDone = true;
      const extra = chunk == null || chunk === "" ? Buffer.alloc(0) : toBuffer(chunk, encoding);
      return rawEnd.call(this, complete(extra), cb);
    }
    return rawEnd.call(this, chunk, encoding, cb);
  };
  return socket;
}

function onceCallback(callback) {
  let done = false;
  return (err, socket) => {
    if (done) return;
    done = true;
    callback(err, socket);
  };
}

function agentFor(profile, protocol) {
  const key = `${profile}:${protocol}`;
  const cached = agents.get(key);
  if (cached) return cached;
  const order = (method, target) => headerOrderFor(profile, method, target);
  const agent = protocol === "http:" ? new http.Agent({ keepAlive: false }) : new https.Agent({ keepAlive: false });
  // Node's Agent constructor keeps createConnection on options, not the instance.
  agent.createConnection = function createConnection(options, callback) {
    const done = onceCallback(callback);
    const socket = protocol === "http:"
      ? net.createConnection(options)
      : tls.connect(profile === "claude-oauth"
        ? claudeOAuthTlsConnectOptions(options)
        : (() => {
          const opts = { ...options };
          delete opts.ALPNProtocols;
          return opts;
        })());
    wrapOrderedHeaderSocket(socket, order);
    socket.once("error", done);
    socket.once(protocol === "http:" ? "connect" : "secureConnect", () => done(null, socket));
    return socket;
  };
  agents.set(key, agent);
  return agent;
}

function headersObject(input) {
  if (!input) return {};
  if (typeof Headers !== "undefined" && input instanceof Headers) {
    return Object.fromEntries(input.entries());
  }
  if (typeof input.forEach === "function" && typeof input.entries === "function") {
    return Object.fromEntries(input.entries());
  }
  return { ...input };
}

function takeHeader(headers, name) {
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  if (key == null) return undefined;
  const value = headers[key];
  delete headers[key];
  return value;
}

function encodeBody(body) {
  if (body == null) return null;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  if (typeof body.getReader === "function") throw new Error("streaming request bodies are not supported");
  return Buffer.from(String(body));
}

async function decodeContent(encoding, buf) {
  const parts = String(encoding || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item && item !== "identity");
  let out = buf;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part === "gzip") out = await gunzip(out);
    else if (part === "deflate") {
      try { out = await inflate(out); }
      catch { out = await inflateRaw(out); }
    } else if (part === "br") out = await brotliDecompress(out);
  }
  return out;
}

function mergeProfileHeaders(profile, input) {
  const incoming = headersObject(input);
  const contentType = takeHeader(incoming, "content-type")
    || (profile === "claude-oauth" ? "application/json" : "application/x-www-form-urlencoded");
  takeHeader(incoming, "host");
  takeHeader(incoming, "content-length");
  takeHeader(incoming, "user-agent");
  takeHeader(incoming, "accept");
  takeHeader(incoming, "accept-encoding");
  takeHeader(incoming, "connection");
  takeHeader(incoming, "originator");
  const headers = profile === "claude-oauth"
    ? claudeOAuthRequestHeaders({ contentType })
    : codexOAuthRequestHeaders({ contentType });
  for (const [key, value] of Object.entries(incoming)) {
    if (value == null || value === "") continue;
    headers[key] = value;
  }
  return headers;
}

export function createImpersonatingFetch(profile) {
  return async function impersonatingFetch(url, init = {}) {
    const parsed = new URL(String(url));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new TypeError(`Unsupported URL protocol: ${parsed.protocol}`);
    }
    const method = String(init.method || "GET").toUpperCase();
    const body = encodeBody(init.body);
    const headers = mergeProfileHeaders(profile, init.headers);
    if (body) headers["Content-Length"] = String(body.length);
    const signal = init.signal;
    const transport = parsed.protocol === "http:" ? http : https;
    return await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason || Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
        return;
      }
      const req = transport.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
        agent: agentFor(profile, parsed.protocol),
        servername: parsed.hostname,
      }, (res) => {
        if (init.redirect === "error" && res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          reject(new Error(`redirect not allowed: ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", async () => {
          try {
            const decoded = await decodeContent(res.headers["content-encoding"], Buffer.concat(chunks));
            const text = decoded.toString("utf8");
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              headers: res.headers,
              async text() { return text; },
              async json() { return JSON.parse(text); },
            });
          } catch (error) {
            reject(error);
          }
        });
      });
      const onAbort = () => {
        req.destroy(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", reject);
      req.on("close", () => signal?.removeEventListener("abort", onAbort));
      if (body) req.write(body);
      req.end();
    });
  };
}

export const claudeOAuthFetch = createImpersonatingFetch("claude-oauth");
export const codexOAuthFetch = createImpersonatingFetch("codex-oauth");

export function defaultFetchFor(providerId) {
  if (providerId === "official-claude") return claudeOAuthFetch;
  if (providerId === "official-codex") return codexOAuthFetch;
  return fetch;
}
