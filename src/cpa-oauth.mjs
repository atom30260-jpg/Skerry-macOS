/**
 * CLIProxyAPI official-CLI OAuth hosts for the desktop bridge.
 * Uses public client IDs and official HTTPS endpoints only.
 * Claude/Codex token exchange impersonates the official CLIs; Grok/Gemini do not.
 * Post-login HTTP executors live in kernel providers, not this file.
 */
import http from "node:http";
import { OAuthError, createHttpDeviceOAuthHost, createHttpDeviceDiscoveryOAuthHost, createHttpOAuthHost } from "./oauth-manager.mjs";
import { decodeJwtPayload, emailFromIdToken, enrichGeminiOAuthToken } from "./antigravity-credential.mjs";
import { extraClaudeOAuthHeaders, extraCodexOAuthHeaders, defaultFetchFor, CODEX_CLI_ORIGINATOR, CODEX_OAUTH_SCOPE } from "./official-client-http.mjs";

/** Public installed-app client IDs already published by the official CLIs / CPA. */
export const CPA_OAUTH_SPECS = Object.freeze({
  // Public Claude Code installed-app client. Login is authorization-code + PKCE
  // with a localhost callback; Anthropic returns JSON tokens that carry
  // account.email_address (not a Google-style id_token). Token HTTP impersonates
  // Claude Code Axios (TLS HTTP/1.1 no ALPN + axios/1.15.2). No Claude CLI.
  "official-claude": {
    flow: "browser",
    enableEnv: "CLAUDE_OAUTH",
    defaultOn: true,
    authorizationEndpoint: "https://claude.ai/oauth/authorize",
    tokenEndpoint: "https://platform.claude.com/v1/oauth/token",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    clientIdEnv: "CLAUDE_OAUTH_CLIENT_ID",
    callbackPort: 54545,
    portEnv: "CLAUDE_OAUTH_CALLBACK_PORT",
    callbackPath: "/callback",
    tokenContentType: "json",
    extraRequestHeaders: extraClaudeOAuthHeaders(),
    extraAuthorizationParams: {
      code: "true",
      scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    },
    extraRefreshParams: {
      scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    },
    exchangeFieldOrder: ["grant_type", "code", "redirect_uri", "client_id", "code_verifier", "state"],
    refreshFieldOrder: ["client_id", "grant_type", "refresh_token", "scope"],
  },
  // Public Codex CLI installed-app client. Login is authorization-code + PKCE
  // with a localhost callback; OpenAI returns form tokens plus an id_token
  // (email + chatgpt_account_id). Token HTTP impersonates Codex TUI identity.
  // No Codex CLI.
  "official-codex": {
    flow: "browser",
    enableEnv: "CODEX_OAUTH",
    defaultOn: true,
    authorizationEndpoint: "https://auth.openai.com/oauth/authorize",
    tokenEndpoint: "https://auth.openai.com/oauth/token",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    clientIdEnv: "CODEX_OAUTH_CLIENT_ID",
    callbackPort: 1455,
    portEnv: "CODEX_OAUTH_CALLBACK_PORT",
    callbackPath: "/auth/callback",
    includeStateInTokenRequest: false,
    extraRequestHeaders: extraCodexOAuthHeaders(),
    extraAuthorizationParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: CODEX_CLI_ORIGINATOR,
      scope: CODEX_OAUTH_SCOPE,
    },
    extraRefreshParams: {
      scope: "openid profile email",
    },
  },
  // Public xAI Grok CLI client. Login is RFC 8628 device code via auth.x.ai
  // discovery; the workbench opens the verification URL in the current browser
  // and stores AT/RT itself. No Grok CLI and no ~/.grok/auth.json.
  "official-grok": {
    flow: "device",
    enableEnv: "GROK_OAUTH",
    defaultOn: true,
    discoveryEndpoint: "https://auth.x.ai/.well-known/openid-configuration",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    clientIdEnv: "GROK_OAUTH_CLIENT_ID",
    scopes: ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"],
    allowedHosts: ["x.ai"],
  },
  // Public Google installed-app client used by Antigravity CLI.
  // Login is authorization-code + PKCE; Google redirects to the official
  // antigravity.google page, which shows a one-time code to paste back.
  "official-gemini": {
    flow: "browser",
    enableEnv: "GEMINI_OAUTH",
    defaultOn: true,
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    clientId: "",
    clientIdEnv: "GEMINI_OAUTH_CLIENT_ID",
    clientSecret: "",
    clientSecretEnv: "GEMINI_OAUTH_CLIENT_SECRET",
    redirectUri: "https://antigravity.google/oauth-callback",
    tokenContentType: "form",
    includeStateInTokenRequest: false,
    extraAuthorizationParams: {
      access_type: "offline",
      prompt: "consent",
      scope: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs https://www.googleapis.com/auth/aicode openid",
    },
  },
});

export const CPA_OAUTH_IDS = Object.freeze(Object.keys(CPA_OAUTH_SPECS));

function envFlag(env, name, defaultOn) {
  const raw = String(env?.[name] ?? "").trim().toLowerCase();
  if (!raw) return defaultOn;
  return !["0", "false", "off", "no"].includes(raw);
}

export function cpaOAuthSpec(providerId, env = process.env) {
  const base = CPA_OAUTH_SPECS[providerId];
  if (!base) return null;
  if (!envFlag(env, base.enableEnv, base.defaultOn)) return null;
  const callbackPort = Number(env?.[base.portEnv] ?? base.callbackPort) || base.callbackPort || 0;
  const configuredClientId = String(env?.[base.clientIdEnv] ?? "").trim();
  const clientId = configuredClientId || (providerId === "official-gemini" && env !== process.env ? "test-gemini-client" : base.clientId);
  const configuredClientSecret = base.clientSecretEnv ? String(env?.[base.clientSecretEnv] ?? "").trim() : "";
  const clientSecret = configuredClientSecret || (providerId === "official-gemini" && env !== process.env ? "test-gemini-secret" : base.clientSecret || "");
  const redirectUri = String(base.redirectUri || "").trim()
    || (base.flow === "browser" && callbackPort ? `http://localhost:${callbackPort}${base.callbackPath}` : null);
  return {
    ...base,
    clientId,
    clientSecret: clientSecret || undefined,
    callbackPort,
    redirectUri,
  };
}

function withGrokAccountEmail(token) {
  if (!token || typeof token !== "object") return token;
  const email = String(token.email || "").trim() || emailFromIdToken(token.id_token ?? token.idToken);
  return email ? { ...token, email } : token;
}

function wrapGrokOAuthHost(host) {
  if (!host) return null;
  const pollDeviceToken = host.pollDeviceToken.bind(host);
  const refreshToken = host.refreshToken.bind(host);
  return {
    ...host,
    async pollDeviceToken(args) {
      return withGrokAccountEmail(await pollDeviceToken(args));
    },
    async refreshToken(args) {
      return withGrokAccountEmail(await refreshToken(args));
    },
  };
}

function wrapGeminiOAuthHost(host, fetchImpl) {
  const exchangeCode = host.exchangeCode.bind(host);
  const refreshToken = host.refreshToken.bind(host);
  return {
    ...host,
    async exchangeCode(args) {
      return enrichGeminiOAuthToken(await exchangeCode(args), { fetchImpl });
    },
    async refreshToken(args) {
      return enrichGeminiOAuthToken(await refreshToken(args), { fetchImpl, resolveEmail: false });
    },
  };
}

function claudeAccountEmail(token) {
  return String(token?.email || token?.account?.email_address || token?.account?.email || "").trim() || null;
}

export function enrichClaudeOAuthToken(token) {
  if (!token || typeof token !== "object") return token;
  const email = claudeAccountEmail(token);
  const accountUUID = String(token.accountUUID || token.account?.uuid || "").trim() || null;
  const organizationUUID = String(token.organizationUUID || token.organization?.uuid || "").trim() || null;
  const organizationName = String(token.organizationName || token.organization?.name || "").trim() || null;
  return {
    ...token,
    ...(email ? { email } : {}),
    ...(accountUUID ? { accountUUID } : {}),
    ...(organizationUUID ? { organizationUUID } : {}),
    ...(organizationName ? { organizationName } : {}),
  };
}

function wrapClaudeOAuthHost(host) {
  if (!host) return null;
  const exchangeCode = host.exchangeCode.bind(host);
  const refreshToken = host.refreshToken.bind(host);
  return {
    ...host,
    async exchangeCode(args) {
      const raw = String(args?.code || "");
      const hash = raw.indexOf("#");
      const code = hash === -1 ? raw : raw.slice(0, hash);
      const fragmentState = hash === -1 ? "" : raw.slice(hash + 1);
      return enrichClaudeOAuthToken(await exchangeCode({
        ...args,
        code,
        state: fragmentState || args.state,
      }));
    },
    async refreshToken(args) {
      return enrichClaudeOAuthToken(await refreshToken(args));
    },
  };
}

export function enrichCodexOAuthToken(token) {
  if (!token || typeof token !== "object") return token;
  const payload = decodeJwtPayload(token.id_token ?? token.idToken);
  const email = String(token.email || payload?.email || "").trim() || emailFromIdToken(token.id_token ?? token.idToken);
  const accountID = String(
    token.accountID
    || payload?.["https://api.openai.com/auth"]?.chatgpt_account_id
    || "",
  ).trim() || null;
  return {
    ...token,
    ...(email ? { email } : {}),
    ...(accountID ? { accountID } : {}),
  };
}

function wrapCodexOAuthHost(host) {
  if (!host) return null;
  const exchangeCode = host.exchangeCode.bind(host);
  const refreshToken = host.refreshToken.bind(host);
  return {
    ...host,
    async exchangeCode(args) {
      return enrichCodexOAuthToken(await exchangeCode(args));
    },
    async refreshToken(args) {
      return enrichCodexOAuthToken(await refreshToken(args));
    },
  };
}

export function createCpaOAuthHost(providerId, env = process.env, { fetchImpl } = {}) {
  const spec = cpaOAuthSpec(providerId, env);
  if (!spec) return null;
  if (spec.flow === "device") {
    const impl = fetchImpl ?? fetch;
    if (spec.discoveryEndpoint) {
      const host = createHttpDeviceDiscoveryOAuthHost({
        discoveryEndpoint: spec.discoveryEndpoint,
        clientId: spec.clientId,
        scopes: spec.scopes ?? [],
        allowedHosts: spec.allowedHosts ?? [],
        fetchImpl: impl,
      });
      return providerId === "official-grok" ? wrapGrokOAuthHost(host) : host;
    }
    return createHttpDeviceOAuthHost({
      deviceAuthorizationEndpoint: spec.deviceAuthorizationEndpoint,
      tokenEndpoint: spec.tokenEndpoint,
      clientId: spec.clientId,
      fetchImpl: impl,
    });
  }
  const redirectUri = spec.redirectUri;
  const impl = fetchImpl ?? defaultFetchFor(providerId);
  const host = createHttpOAuthHost({
    authorizationEndpoint: spec.authorizationEndpoint,
    tokenEndpoint: spec.tokenEndpoint,
    clientId: spec.clientId,
    clientSecret: spec.clientSecret,
    extraAuthorizationParams: spec.extraAuthorizationParams ?? {},
    extraTokenParams: spec.extraTokenParams ?? {},
    extraRefreshParams: spec.extraRefreshParams ?? {},
    extraRequestHeaders: spec.extraRequestHeaders ?? {},
    exchangeFieldOrder: spec.exchangeFieldOrder,
    refreshFieldOrder: spec.refreshFieldOrder,
    allowedRedirectUris: redirectUri
      ? [redirectUri, redirectUri.replace("://localhost", "://127.0.0.1")]
      : [],
    tokenContentType: spec.tokenContentType ?? "form",
    includeStateInTokenRequest: spec.includeStateInTokenRequest ?? true,
    fetchImpl: impl,
  });
  if (providerId === "official-gemini" && host) return wrapGeminiOAuthHost(host, impl);
  if (providerId === "official-claude" && host) return wrapClaudeOAuthHost(host);
  if (providerId === "official-codex" && host) return wrapCodexOAuthHost(host);
  return host;
}

export function installCpaOAuthHosts(hosts, env = process.env) {
  for (const id of CPA_OAUTH_IDS) {
    if (hosts[id]) continue;
    const host = createCpaOAuthHost(id, env);
    if (host) hosts[id] = host;
  }
  return hosts;
}

function requestUrl(req, port) {
  try {
    return new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  } catch {
    return null;
  }
}

function listenHttp(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

export async function bindOAuthCallbackServer({ port, path, onCallback }) {
  let callbackPort = Number(port) || 0;
  const handler = (req, res) => {
    const url = requestUrl(req, callbackPort);
    if (!url) {
      res.writeHead(400);
      res.end();
      return;
    }
    if (url.pathname !== path) {
      res.writeHead(404);
      res.end();
      return;
    }
    Promise.resolve(onCallback({
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
      error: url.searchParams.get("error") ?? undefined,
      errorDescription: url.searchParams.get("error_description") ?? undefined,
    })).then((ok) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(ok === false
        ? "<!doctype html><title>OAuth failed</title><p>登录失败，可以关闭此窗口。</p>"
        : "<!doctype html><title>OAuth connected</title><p>登录完成，可以关闭此窗口。</p>");
    }).catch(() => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end("<!doctype html><title>OAuth failed</title><p>登录失败，可以关闭此窗口。</p>");
    });
  };

  const servers = [];
  try {
    const ipv4 = await listenHttp(http.createServer(handler), callbackPort, "127.0.0.1");
    callbackPort = ipv4.address().port;
    servers.push(ipv4);
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      throw new OAuthError("oauth_callback_port_in_use", `OAuth callback port ${callbackPort} is already in use.`, 409);
    }
    throw error;
  }
  try {
    servers.push(await listenHttp(http.createServer(handler), callbackPort, "::1"));
  } catch {
    /* IPv6 is optional; localhost on Windows may still land on 127.0.0.1 */
  }
  return {
    port: callbackPort,
    close() {
      for (const server of servers) {
        try { server.close(); } catch { /* already closed */ }
      }
    },
  };
}


