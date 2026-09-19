const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";

export function decodeJwtPayload(jwtToken) {
  if (!jwtToken || typeof jwtToken !== "string") return null;
  const parts = jwtToken.split(".");
  if (parts.length < 2) return null;
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function emailFromIdToken(idToken) {
  const email = String(decodeJwtPayload(idToken)?.email || "").trim();
  return email || null;
}

function expiryMillis(source, now = Date.now()) {
  const rawExpiry = source?.expiry ?? source?.expiry_date ?? source?.expiresAt ?? source?.expires_at ?? null;
  if (rawExpiry != null && rawExpiry !== "") {
    if (typeof rawExpiry === "number" || /^\d+(?:\.\d+)?$/.test(String(rawExpiry))) {
      const numeric = Number(rawExpiry);
      return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(String(rawExpiry));
    if (Number.isFinite(parsed)) return parsed;
  }
  if (source?.expires_in != null && Number.isFinite(Number(source.expires_in))) {
    return now + Number(source.expires_in) * 1000;
  }
  return null;
}

async function fetchGoogleEmail(accessToken, fetchImpl) {
  const response = await fetchImpl(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => ({}));
  return String(body?.email || "").trim() || null;
}

/** After Google token exchange: keep token fields and resolve account email. */
export async function enrichGeminiOAuthToken(token, { fetchImpl = fetch, resolveEmail = true } = {}) {
  if (!token || typeof token !== "object") return token;
  const accessToken = token.access_token ?? token.accessToken;
  const idToken = token.id_token ?? token.idToken ?? null;
  let email = String(token.email || "").trim() || emailFromIdToken(idToken);
  if (!email && resolveEmail && accessToken) {
    try { email = await fetchGoogleEmail(String(accessToken), fetchImpl); } catch { email = null; }
  }
  const expiry_date = expiryMillis(token);
  return {
    ...token,
    ...(accessToken ? { access_token: String(accessToken) } : {}),
    ...((token.refresh_token ?? token.refreshToken) ? { refresh_token: String(token.refresh_token ?? token.refreshToken) } : {}),
    ...((token.token_type ?? token.tokenType) ? { token_type: String(token.token_type ?? token.tokenType) } : {}),
    ...(idToken ? { id_token: String(idToken) } : {}),
    ...(expiry_date != null ? { expiry_date } : {}),
    ...(email ? { email } : {}),
  };
}
