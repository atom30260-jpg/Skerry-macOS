import { createHash, randomBytes, randomUUID } from "node:crypto";

export class OAuthError extends Error {
  constructor(code, message, status = 409, details = {}) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function verifier() {
  return base64url(randomBytes(32));
}

function expiresAtFrom(token, now) {
  if (token?.expiresAt != null) return Number(token.expiresAt);
  if (token?.expires_at != null) return Number(token.expires_at) * 1000;
  if (token?.expires_in != null && Number.isFinite(Number(token.expires_in))) {
    return now() + Number(token.expires_in) * 1000;
  }
  return null;
}

function nonempty(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function pickCredential(token, previous, ...keys) {
  for (const source of [token, previous]) {
    if (!source) continue;
    for (const key of keys) {
      const value = nonempty(source[key]);
      if (value) return value;
    }
  }
  return null;
}

function normalizeToken(token, now, previous = null) {
  if (!token || typeof token !== "object") return null;
  const accessToken = pickCredential(token, previous, "accessToken", "access_token");
  if (!accessToken) return null;
  const refreshToken = pickCredential(token, previous, "refreshToken", "refresh_token");
  return {
    ...previous,
    ...token,
    accessToken,
    access_token: accessToken,
    refreshToken,
    refresh_token: refreshToken,
    expiresAt: expiresAtFrom(token, now) ?? previous?.expiresAt ?? null,
    tokenType: token.tokenType ?? token.token_type ?? previous?.tokenType ?? "Bearer",
    scope: token.scope ?? token.scopes ?? previous?.scope ?? null,
  };
}

const TERMINAL_REFRESH_CODES = new Set([
  "invalid_grant",
  "invalid_token",
  "unauthorized_client",
  "invalid_client",
  "oauth_refresh_token_missing",
]);

function isTerminalRefreshError(error) {
  return TERMINAL_REFRESH_CODES.has(String(error?.code || ""));
}

function publicRefreshFailure(error) {
  return {
    code: String(error?.code || "oauth_refresh_failed"),
    message: "授权已失效，请重新登录。",
  };
}

function publicToken(token) {
  return {
    expiresAt: token?.expiresAt ?? null,
    scope: token?.scope ?? token?.scopes ?? null,
    tokenType: token?.tokenType ?? token?.token_type ?? "Bearer",
  };
}

function isExpired(token, now, leewayMs = 0) {
  return token?.expiresAt != null && Number(token.expiresAt) <= now() + leewayMs;
}

function publicOAuthFailure(error) {
  const code = String(error?.code || "oauth_failed");
  const messages = {
    access_denied: "授权被取消或拒绝。",
    oauth_denied: "授权被取消或拒绝。",
    invalid_grant: "授权码已失效、已被使用，或回调地址不匹配；请重新发起登录。",
    invalid_client: "OAuth 客户端配置被服务端拒绝。",
    unauthorized_client: "当前 OAuth 客户端不具备此授权权限。",
    redirect_uri_mismatch: "回调地址与 OAuth 客户端配置不一致。",
    oauth_code_required: "授权回调中没有收到授权码。",
    oauth_state_invalid: "授权状态已失效或不匹配；请重新发起登录。",
    oauth_state_expired: "授权等待超时；请重新发起登录。",
    oauth_token_exchange_failed: "授权码已收到，但换取登录凭据失败。",
    oauth_token_http_error: "授权服务拒绝了登录凭据请求。",
    oauth_token_missing: "授权服务未返回可用登录凭据。",
    oauth_credential_sync_failed: "网页登录已完成，但未能保存授权凭证。",
  };
  return { code, message: messages[code] || "官方登录未完成，请重新发起授权。" };
}

function publicTransaction(transaction) {
  if (!transaction) return null;
  const result = {
    transactionId: transaction.transactionId,
    providerId: transaction.providerId,
    flow: transaction.flow,
    status: transaction.status,
    createdAt: transaction.createdAt,
    expiresAt: transaction.createdAt + transaction.ttlMs,
  };
  if (transaction.error) result.error = transaction.error;
  if (transaction.flow === "device") {
    result.verificationUri = transaction.verificationUri ?? null;
    result.verificationUriComplete = transaction.verificationUriComplete ?? null;
    result.userCode = transaction.userCode ?? null;
    result.interval = transaction.interval ?? null;
    result.pollAfter = transaction.pollAfter ?? null;
  }
  return result;
}

function hostSupportsBrowser(host) {
  return typeof host?.createAuthorizationUrl === "function" && typeof host?.exchangeCode === "function";
}

function hostSupportsDevice(host) {
  return typeof host?.startDeviceAuthorization === "function" && typeof host?.pollDeviceToken === "function";
}

function endpointAllowed(value, allowInsecureHttp) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || (allowInsecureHttp && protocol === "http:");
  } catch {
    return false;
  }
}

/**
 * Provider-neutral OAuth lifecycle. Provider hosts own endpoint details and
 * return token objects; this manager owns transaction/state validation,
 * cancellation, refresh coordination and secure storage.
 */
export class OAuthManager {
  #hosts = new Map();
  #transactions = new Map();
  #tokens = new Map();
  #refreshFlights = new Map();
  #refreshErrors = new Map();
  #stateTtlMs;
  #now;
  #loadToken;
  #saveToken;
  #deleteToken;
  #refreshLeewayMs;

  constructor({
    hosts = {},
    stateTtlMs = 10 * 60 * 1000,
    transactionTtlMs,
    refreshLeewayMs = 30 * 1000,
    now = () => Date.now(),
    loadToken,
    saveToken,
    deleteToken,
  } = {}) {
    this.#stateTtlMs = Number(transactionTtlMs ?? stateTtlMs);
    this.#refreshLeewayMs = Math.max(0, Number(refreshLeewayMs) || 0);
    this.#now = now;
    this.#loadToken = loadToken;
    this.#saveToken = saveToken;
    this.#deleteToken = deleteToken;
    for (const [id, host] of Object.entries(hosts)) this.register(id, host);
  }

  register(providerId, host) {
    if (!providerId || !host || (!hostSupportsBrowser(host) && !hostSupportsDevice(host))) {
      throw new TypeError("OAuth host must define browser or device flow methods.");
    }
    this.#hosts.set(String(providerId), host);
    return this;
  }

  hasHost(providerId) {
    return this.#hosts.has(String(providerId));
  }

  #cleanup() {
    const now = this.#now();
    for (const [key, transaction] of this.#transactions) {
      if (now - transaction.createdAt > transaction.ttlMs) {
        transaction.status = "expired";
        this.#transactions.delete(key);
      }
    }
  }

  #load(providerId) {
    const id = String(providerId);
    if (this.#tokens.has(id)) return this.#tokens.get(id);
    const loaded = this.#loadToken?.(id);
    if (loaded && typeof loaded.then === "function") return null;
    if (loaded) this.#tokens.set(id, loaded);
    return loaded ?? null;
  }

  status(providerId) {
    this.#cleanup();
    const id = String(providerId);
    const token = this.#load(id);
    const host = this.#hosts.get(id);
    const transaction = [...this.#transactions.values()]
      .filter((item) => item.providerId === id)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    const authError = token ? this.#refreshErrors.get(id) ?? null : null;
    return {
      providerId: id,
      configured: Boolean(host),
      flow: host?.flow ?? (hostSupportsDevice(host) ? "device" : hostSupportsBrowser(host) ? "browser" : null),
      connected: Boolean(token),
      expired: isExpired(token, this.#now) || Boolean(authError),
      refreshable: Boolean(nonempty(token?.refreshToken ?? token?.refresh_token) && typeof host?.refreshToken === "function"),
      expiresAt: token?.expiresAt ?? null,
      transaction: publicTransaction(transaction),
      ...(authError ? { authError } : {}),
    };
  }

  transaction(providerId, transactionId) {
    this.#cleanup();
    const transaction = this.#transactions.get(String(transactionId))
      ?? [...this.#transactions.values()].find((item) => item.transactionId === String(transactionId));
    if (!transaction || transaction.providerId !== String(providerId)) {
      throw new OAuthError("oauth_transaction_not_found", "OAuth transaction is unknown or expired.", 404);
    }
    return publicTransaction(transaction);
  }

  /** Kernel/provider use only; callers must never expose this value to UI. */
  accessToken(providerId) {
    const token = this.#load(providerId);
    return token?.accessToken ?? token?.access_token ?? null;
  }

  /**
   * Return a token for a real provider call. Refresh is singleflight per card,
   * so concurrent runs never exchange the same refresh token twice.
   */
  async accessTokenForRuntime(providerId, { forceRefresh = false } = {}) {
    const id = String(providerId);
    const token = this.#load(id);
    if (!forceRefresh && token?.accessToken && !isExpired(token, this.#now, this.#refreshLeewayMs)) {
      return token.accessToken;
    }
    if (nonempty(token?.refreshToken ?? token?.refresh_token)) {
      await this.refresh(id);
      return this.accessToken(id);
    }
    if (token?.accessToken && !isExpired(token, this.#now)) return token.accessToken;
    throw new OAuthError("oauth_access_token_unavailable", `No usable OAuth access token is available for ${id}.`, 409);
  }

  disconnect(providerId) {
    const id = String(providerId);
    for (const [key, transaction] of this.#transactions) {
      if (transaction.providerId === id) this.#transactions.delete(key);
    }
    const removed = this.#tokens.delete(id);
    this.#refreshErrors.delete(id);
    this.#deleteToken?.(id);
    return removed;
  }

  async start(providerId, { redirectUri, scopes = [], ttlMs } = {}) {
    this.#cleanup();
    const id = String(providerId);
    const host = this.#hosts.get(id);
    if (!host) throw new OAuthError("oauth_host_unavailable", `OAuth host is not configured for ${id}.`, 501);
    const flow = host.flow ?? (hostSupportsDevice(host) ? "device" : "browser");
    const transactionId = randomUUID();
    const createdAt = this.#now();
    const transaction = {
      providerId: id,
      transactionId,
      flow,
      status: flow === "device" ? "awaiting_device" : "awaiting_browser",
      createdAt,
      ttlMs: Number(ttlMs ?? this.#stateTtlMs),
    };

    if (flow === "device") {
      try {
        const device = await host.startDeviceAuthorization({ scopes });
        const deviceCode = device?.deviceCode ?? device?.device_code;
        if (!deviceCode) throw new OAuthError("oauth_device_code_missing", "OAuth host returned no device code.", 502);
        transaction.deviceCode = String(deviceCode);
        transaction.verificationUri = device.verificationUri ?? device.verification_uri ?? device.verification_url ?? null;
        transaction.verificationUriComplete = device.verificationUriComplete ?? device.verification_uri_complete ?? null;
        transaction.userCode = device.userCode ?? device.user_code ?? null;
        transaction.interval = Math.max(1, Number(device.interval ?? 5));
        transaction.pollAfter = createdAt;
        this.#transactions.set(transactionId, transaction);
        return {
          providerId: id,
          transactionId,
          state: transactionId,
          status: transaction.status,
          flow: "device",
          expiresAt: createdAt + transaction.ttlMs,
          verificationUri: transaction.verificationUri,
          verificationUriComplete: transaction.verificationUriComplete,
          userCode: transaction.userCode,
          interval: transaction.interval,
        };
      } catch (error) {
        if (error instanceof OAuthError) throw error;
        throw new OAuthError("oauth_device_start_failed", error instanceof Error ? error.message : String(error), 502);
      }
    }

    if (!redirectUri) throw new OAuthError("redirect_uri_required", "redirectUri is required.", 400);
    const codeVerifier = verifier();
    transaction.state = randomUUID();
    transaction.codeVerifier = codeVerifier;
    transaction.redirectUri = String(redirectUri);
    this.#transactions.set(transaction.state, transaction);
    try {
      const authorizationUrl = await host.createAuthorizationUrl({
        state: transaction.state,
        codeVerifier,
        redirectUri: transaction.redirectUri,
        scopes,
      });
      if (!authorizationUrl) throw new OAuthError("oauth_host_invalid", "OAuth host returned no authorization URL.", 502);
      // Keep the short-lived authorization URL only inside the Host transaction.
      // It is needed for a user-initiated re-open, but must never be persisted with tokens.
      transaction.authorizationUrl = String(authorizationUrl);
      return {
        providerId: id,
        transactionId,
        authorizationUrl: String(authorizationUrl),
        state: transaction.state,
        status: transaction.status,
        flow: "browser",
        expiresAt: createdAt + transaction.ttlMs,
      };
    } catch (error) {
      this.#transactions.delete(transaction.state);
      if (error instanceof OAuthError) throw error;
      throw new OAuthError("oauth_authorization_failed", error instanceof Error ? error.message : String(error), 502);
    }
  }

  #getTransaction(providerId, stateOrTransactionId) {
    const id = String(providerId);
    const key = String(stateOrTransactionId ?? "");
    const transaction = this.#transactions.get(key)
      ?? [...this.#transactions.values()].find((item) => item.transactionId === key);
    if (!transaction || transaction.providerId !== id) {
      throw new OAuthError("oauth_state_invalid", "OAuth state is invalid or expired.", 409);
    }
    if (this.#now() - transaction.createdAt > transaction.ttlMs) {
      this.#transactions.delete(key);
      throw new OAuthError("oauth_state_expired", "OAuth state is expired.", 409);
    }
    return transaction;
  }

  async #store(providerId, token, previous = null) {
    const normalized = normalizeToken(token, this.#now, previous);
    if (!normalized) throw new OAuthError("oauth_token_missing", "OAuth host returned no access token.", 502);
    const id = String(providerId);
    this.#tokens.set(id, normalized);
    this.#refreshErrors.delete(id);
    await this.#saveToken?.(id, normalized);
    return normalized;
  }

  /** Host-only: retrieve the active authorization or device verification URL for a retry. */
  launchUrl(providerId, stateOrTransactionId) {
    const transaction = this.#getTransaction(providerId, stateOrTransactionId);
    if (transaction.status === "cancelled" || transaction.status === "completed") {
      throw new OAuthError("oauth_transaction_finished", "OAuth transaction has already finished.", 409);
    }
    return transaction.flow === "device"
      ? (transaction.verificationUriComplete ?? transaction.verificationUri ?? null)
      : (transaction.authorizationUrl ?? null);
  }

  async callback(providerId, { code, state, error, errorDescription } = {}) {
    const transaction = this.#getTransaction(providerId, state);
    if (transaction.flow !== "browser") throw new OAuthError("oauth_flow_invalid", "This transaction does not accept a browser callback.", 409);
    if (transaction.status !== "awaiting_browser") {
      throw new OAuthError("oauth_transaction_finished", "OAuth transaction has already been handled.", 409);
    }
    transaction.status = "exchanging";
    if (error) {
      transaction.status = "error";
      const failure = new OAuthError("oauth_denied", errorDescription || String(error), 409);
      transaction.error = publicOAuthFailure(failure);
      throw failure;
    }
    if (!code) {
      transaction.status = "error";
      const failure = new OAuthError("oauth_code_required", "OAuth callback code is required.", 400);
      transaction.error = publicOAuthFailure(failure);
      throw failure;
    }
    const host = this.#hosts.get(String(providerId));
    try {
      const token = await host.exchangeCode({
        code: String(code),
        state: transaction.state,
        codeVerifier: transaction.codeVerifier,
        redirectUri: transaction.redirectUri,
      });
      const normalized = await this.#store(providerId, token);
      transaction.status = "completed";
      return { providerId: String(providerId), status: "connected", ...publicToken(normalized) };
    } catch (err) {
      transaction.status = "error";
      const failure = err instanceof OAuthError
        ? err
        : new OAuthError("oauth_token_exchange_failed", err instanceof Error ? err.message : String(err), 502);
      transaction.error = publicOAuthFailure(failure);
      throw failure;
    }
  }

  async poll(providerId, stateOrTransactionId) {
    const transaction = this.#getTransaction(providerId, stateOrTransactionId);
    if (transaction.flow !== "device") throw new OAuthError("oauth_flow_invalid", "This transaction does not accept device polling.", 409);
    if (transaction.status === "completed") return { providerId: String(providerId), status: "connected", ...publicToken(this.#load(providerId)) };
    if (transaction.status === "cancelled") throw new OAuthError("oauth_transaction_cancelled", "OAuth transaction was cancelled.", 409);
    const now = this.#now();
    if (transaction.pollAfter && now < transaction.pollAfter) {
      return { providerId: String(providerId), status: "pending", retryAfter: Math.ceil((transaction.pollAfter - now) / 1000), transaction: publicTransaction(transaction) };
    }
    transaction.status = "polling";
    const host = this.#hosts.get(String(providerId));
    try {
      const token = await host.pollDeviceToken({
        deviceCode: transaction.deviceCode,
        interval: transaction.interval,
      });
      const normalized = await this.#store(providerId, token);
      transaction.status = "completed";
      return { providerId: String(providerId), status: "connected", ...publicToken(normalized) };
    } catch (error) {
      if (error instanceof OAuthError && ["authorization_pending", "slow_down"].includes(error.code)) {
        transaction.status = "awaiting_device";
        if (error.code === "slow_down") transaction.interval = Math.min(transaction.interval + 5, 60);
        transaction.pollAfter = this.#now() + transaction.interval * 1000;
        return { providerId: String(providerId), status: "pending", retryAfter: transaction.interval, transaction: publicTransaction(transaction) };
      }
      if (error instanceof OAuthError && ["access_denied", "expired_token"].includes(error.code)) {
        transaction.status = error.code === "expired_token" ? "expired" : "error";
        this.#transactions.delete(transaction.transactionId);
        throw error;
      }
      transaction.status = "error";
      throw error instanceof OAuthError
        ? error
        : new OAuthError("oauth_device_poll_failed", error instanceof Error ? error.message : String(error), 502);
    }
  }

  cancel(providerId, stateOrTransactionId) {
    const transaction = this.#getTransaction(providerId, stateOrTransactionId);
    transaction.status = "cancelled";
    this.#transactions.delete(transaction.state ?? transaction.transactionId);
    return { providerId: String(providerId), transactionId: transaction.transactionId, status: "cancelled" };
  }

  async refresh(providerId) {
    const id = String(providerId);
    if (this.#refreshFlights.has(id)) return this.#refreshFlights.get(id);
    const flight = this.#refreshInternal(id);
    this.#refreshFlights.set(id, flight);
    try {
      return await flight;
    } finally {
      if (this.#refreshFlights.get(id) === flight) this.#refreshFlights.delete(id);
    }
  }

  async #refreshInternal(id) {
    const host = this.#hosts.get(id);
    if (!host || typeof host.refreshToken !== "function") {
      throw new OAuthError("oauth_refresh_unavailable", `OAuth refresh is not configured for ${id}.`, 501);
    }
    const current = this.#load(id);
    const refreshToken = nonempty(current?.refreshToken ?? current?.refresh_token);
    if (!refreshToken) {
      const missing = new OAuthError("oauth_refresh_token_missing", "No refresh token is available.", 409);
      this.#refreshErrors.set(id, publicRefreshFailure(missing));
      throw missing;
    }
    try {
      const token = await host.refreshToken({ refreshToken });
      const normalized = await this.#store(id, token, current);
      return { providerId: id, status: "connected", ...publicToken(normalized) };
    } catch (err) {
      const error = err instanceof OAuthError
        ? err
        : new OAuthError("oauth_refresh_failed", err instanceof Error ? err.message : String(err), 502);
      if (isTerminalRefreshError(error)) this.#refreshErrors.set(id, publicRefreshFailure(error));
      throw error;
    }
  }
}

/** Generic authorization-code + PKCE host for official provider endpoints. */
function compactParams(object) {
  const output = {};
  for (const [key, value] of Object.entries(object)) {
    if (value == null || value === "") continue;
    output[key] = typeof value === "string" ? value : String(value);
  }
  return output;
}

function orderedJson(payload, fieldOrder) {
  if (!fieldOrder?.length) return JSON.stringify(payload);
  const ordered = {};
  for (const key of fieldOrder) {
    if (payload[key] != null && payload[key] !== "") ordered[key] = payload[key];
  }
  for (const [key, value] of Object.entries(payload)) {
    if (ordered[key] !== undefined) continue;
    ordered[key] = value;
  }
  return JSON.stringify(ordered);
}

export function createHttpOAuthHost({
  authorizationEndpoint,
  tokenEndpoint,
  clientId,
  clientSecret,
  extraAuthorizationParams = {},
  extraTokenParams = {},
  extraRefreshParams = {},
  exchangeFieldOrder,
  refreshFieldOrder,
  allowedRedirectUris = [],
  allowInsecureHttp = false,
  tokenContentType = "form",
  includeStateInTokenRequest = true,
  extraRequestHeaders = {},
  fetchImpl = fetch,
} = {}) {
  if (!authorizationEndpoint
    || !tokenEndpoint
    || !clientId
    || !endpointAllowed(authorizationEndpoint, allowInsecureHttp)
    || !endpointAllowed(tokenEndpoint, allowInsecureHttp)) return null;
  const jsonTokenBody = tokenContentType === "json" || tokenContentType === "application/json";
  const tokenRequest = async (params) => {
    const payload = compactParams({
      client_id: clientId,
      ...extraTokenParams,
      ...params,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    });
    const fieldOrder = params.grant_type === "refresh_token" ? refreshFieldOrder : exchangeFieldOrder;
    const response = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        ...extraRequestHeaders,
        "Content-Type": jsonTokenBody ? "application/json" : "application/x-www-form-urlencoded",
      },
      body: jsonTokenBody ? orderedJson(payload, fieldOrder) : new URLSearchParams(payload),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new OAuthError(body.error ?? "oauth_token_http_error", `OAuth token endpoint returned HTTP ${response.status}`, response.status === 400 ? 409 : 502);
    return body;
  };
  return {
    flow: "browser",
    async createAuthorizationUrl({ state, codeVerifier, redirectUri, scopes = [] }) {
      if (allowedRedirectUris.length && !allowedRedirectUris.includes(redirectUri)) {
        throw new OAuthError("redirect_uri_not_allowed", "redirectUri is not allowed for this OAuth provider.", 400);
      }
      const url = new URL(authorizationEndpoint);
      const params = {
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
        code_challenge_method: "S256",
        ...extraAuthorizationParams,
      };
      if (scopes.length) params.scope = scopes.join(" ");
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      return url.toString();
    },
    exchangeCode({ code, codeVerifier, redirectUri, state }) {
      return tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        ...(includeStateInTokenRequest ? { state } : {}),
      });
    },
    refreshToken({ refreshToken }) {
      return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, ...extraRefreshParams });
    },
  };
}

/** Generic RFC 8628 device-authorization host for providers such as xAI/Kimi. */
export function createHttpDeviceOAuthHost({
  deviceAuthorizationEndpoint,
  tokenEndpoint,
  clientId,
  clientSecret,
  extraDeviceParams = {},
  extraTokenParams = {},
  allowInsecureHttp = false,
  fetchImpl = fetch,
} = {}) {
  if (!deviceAuthorizationEndpoint
    || !tokenEndpoint
    || !clientId
    || !endpointAllowed(deviceAuthorizationEndpoint, allowInsecureHttp)
    || !endpointAllowed(tokenEndpoint, allowInsecureHttp)) return null;
  const request = async (endpoint, params) => {
    const body = new URLSearchParams({ client_id: clientId, ...params });
    if (clientSecret) body.set("client_secret", clientSecret);
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    const payload = await response.json().catch(() => ({}));
    if (payload.error === "authorization_pending" || payload.error === "slow_down") {
      throw new OAuthError(payload.error, payload.error_description ?? payload.error, 409);
    }
    if (!response.ok) {
      const code = payload.error ?? "oauth_device_http_error";
      const status = code === "access_denied" ? 403 : 502;
      throw new OAuthError(code, payload.error_description ?? `OAuth device endpoint returned HTTP ${response.status}`, status);
    }
    return payload;
  };
  return {
    flow: "device",
    async startDeviceAuthorization({ scopes = [] }) {
      const payload = await request(deviceAuthorizationEndpoint, {
        ...extraDeviceParams,
        scope: scopes.join(" "),
      });
      return payload;
    },
    async pollDeviceToken({ deviceCode }) {
      return request(tokenEndpoint, {
        ...extraTokenParams,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
      });
    },
    refreshToken({ refreshToken }) {
      return request(tokenEndpoint, { ...extraTokenParams, grant_type: "refresh_token", refresh_token: refreshToken });
    },
  };
}

/**
 * RFC 8628 host whose device/token endpoints come from OIDC discovery.
 * This is used by providers such as xAI where endpoint URLs are not stable
 * configuration and must be validated before they are used.
 */
export function createHttpDeviceDiscoveryOAuthHost({
  discoveryEndpoint,
  clientId,
  clientSecret,
  scopes = [],
  extraDeviceParams = {},
  extraTokenParams = {},
  allowInsecureHttp = false,
  allowedHosts = [],
  fetchImpl = fetch,
} = {}) {
  if (!discoveryEndpoint || !clientId || !endpointAllowed(discoveryEndpoint, allowInsecureHttp)) return null;
  const configuredHosts = allowedHosts.map((item) => String(item).toLowerCase().replace(/^\./, "")).filter(Boolean);
  const isAllowedEndpoint = (value) => {
    if (!endpointAllowed(value, allowInsecureHttp)) return false;
    if (!configuredHosts.length) return true;
    try {
      const host = new URL(value).hostname.toLowerCase();
      return configuredHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    } catch {
      return false;
    }
  };
  let discoveryFlight = null;
  const discover = async () => {
    if (discoveryFlight) return discoveryFlight;
    discoveryFlight = (async () => {
      const response = await fetchImpl(discoveryEndpoint, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new OAuthError("oauth_discovery_http_error", `OAuth discovery returned HTTP ${response.status}.`, 502);
      const deviceEndpoint = payload.device_authorization_endpoint;
      const tokenEndpoint = payload.token_endpoint;
      if (!isAllowedEndpoint(deviceEndpoint) || !isAllowedEndpoint(tokenEndpoint)) {
        throw new OAuthError("oauth_discovery_endpoint_invalid", "OAuth discovery returned an invalid endpoint.", 502);
      }
      return { deviceEndpoint, tokenEndpoint };
    })();
    try {
      return await discoveryFlight;
    } catch (error) {
      discoveryFlight = null;
      throw error;
    }
  };
  const request = async (endpoint, params) => {
    const body = new URLSearchParams({ client_id: clientId, ...params });
    if (clientSecret) body.set("client_secret", clientSecret);
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    const payload = await response.json().catch(() => ({}));
    if (payload.error === "authorization_pending" || payload.error === "slow_down") {
      throw new OAuthError(payload.error, payload.error_description ?? payload.error, 409);
    }
    if (!response.ok) {
      const code = payload.error ?? "oauth_device_http_error";
      const status = code === "access_denied" ? 403 : 502;
      throw new OAuthError(code, payload.error_description ?? `OAuth device endpoint returned HTTP ${response.status}`, status);
    }
    return payload;
  };
  return {
    flow: "device",
    async startDeviceAuthorization({ scopes: requestedScopes = [] } = {}) {
      const { deviceEndpoint } = await discover();
      const effectiveScopes = requestedScopes.length ? requestedScopes : scopes;
      return request(deviceEndpoint, {
        ...extraDeviceParams,
        ...(effectiveScopes.length ? { scope: effectiveScopes.join(" ") } : {}),
      });
    },
    async pollDeviceToken({ deviceCode }) {
      const { tokenEndpoint } = await discover();
      return request(tokenEndpoint, {
        ...extraTokenParams,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
      });
    },
    async refreshToken({ refreshToken }) {
      const { tokenEndpoint } = await discover();
      return request(tokenEndpoint, { ...extraTokenParams, grant_type: "refresh_token", refresh_token: refreshToken });
    },
  };
}
