// Supabase Auth for the optional worker lane.
// The publishable or anon key travels in the apikey header. The user access
// token travels in Authorization. A publishable key is never a bearer token.

const SKEW_MS = 60_000;

export function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = globalThis.Buffer
      ? globalThis.Buffer.from(padded, "base64").toString("utf8")
      : globalThis.atob(padded);
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

export function classifyApiKey(raw) {
  const key = String(raw || "").trim();
  if (!key) return { ok: false, error: "missing_anon_key" };
  if (key.startsWith("sb_secret_")) return { ok: false, error: "secret_key_rejected" };
  if (key.startsWith("eyJ")) {
    const payload = decodeJwtPayload(key);
    if (payload?.role === "service_role") return { ok: false, error: "service_role_rejected" };
    return { ok: true, kind: payload?.role === "anon" ? "anon_jwt" : "jwt", key };
  }
  if (key.startsWith("sb_publishable_")) return { ok: true, kind: "publishable", key };
  return { ok: true, kind: "apikey", key };
}

export function workerAuthHeaders(apiKey, accessToken) {
  const classified = classifyApiKey(apiKey);
  if (!classified.ok) {
    const error = new Error(classified.error);
    error.code = classified.error;
    throw error;
  }
  const token = String(accessToken || "").trim();
  if (!token) {
    const error = new Error("missing_access_token");
    error.code = "missing_access_token";
    throw error;
  }
  if (token.startsWith("sb_publishable_") || token.startsWith("sb_secret_") || token === classified.key) {
    const error = new Error("api_key_is_not_a_bearer_token");
    error.code = "api_key_is_not_a_bearer_token";
    throw error;
  }
  const bearerPayload = token.startsWith("eyJ") ? decodeJwtPayload(token) : null;
  if (bearerPayload?.role === "service_role" || bearerPayload?.role === "anon") {
    const error = new Error(bearerPayload.role === "service_role" ? "service_role_rejected" : "api_key_is_not_a_bearer_token");
    error.code = error.message;
    throw error;
  }
  return {
    apikey: classified.key,
    authorization: `Bearer ${token}`,
  };
}

export function authTokenUrl(backendUrl, grantType) {
  const base = String(backendUrl || "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  return `${base}/auth/v1/token?grant_type=${grantType}`;
}

function sessionFromAuth(data, now) {
  const accessToken = String(data?.access_token || "");
  const refreshToken = String(data?.refresh_token || "");
  if (!accessToken || !refreshToken) return { ok: false, error: "auth_failed" };
  const expiresIn = Number(data.expires_in) || 3600;
  return {
    ok: true,
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1000,
  };
}

async function postToken({ fetchImpl, backendUrl, apiKey, grantType, body }) {
  const classified = classifyApiKey(apiKey);
  if (!classified.ok) return { ok: false, error: classified.error };
  let response;
  try {
    response = await fetchImpl(authTokenUrl(backendUrl, grantType), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: classified.key,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, error: "network_error", network: true, detail: String(error?.message || error) };
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message = data?.error_description || data?.msg || data?.error || `http_${response.status}`;
    return { ok: false, error: String(message), status: response.status };
  }
  return { ok: true, data };
}

export async function signInWithPassword({ fetchImpl, backendUrl, apiKey, email, password, now = Date.now() }) {
  const address = String(email || "").trim();
  const secret = String(password || "");
  if (!address || !secret) return { ok: false, error: "missing_credentials" };
  const posted = await postToken({
    fetchImpl,
    backendUrl,
    apiKey,
    grantType: "password",
    body: { email: address, password: secret },
  });
  if (!posted.ok) return posted;
  return sessionFromAuth(posted.data, now);
}

export async function refreshAccessToken({ fetchImpl, backendUrl, apiKey, refreshToken, now = Date.now() }) {
  const refresh = String(refreshToken || "").trim();
  if (!refresh) return { ok: false, error: "missing_refresh_token" };
  const posted = await postToken({
    fetchImpl,
    backendUrl,
    apiKey,
    grantType: "refresh_token",
    body: { refresh_token: refresh },
  });
  if (!posted.ok) return posted;
  return sessionFromAuth(posted.data, now);
}

export function accessTokenFresh(session, now = Date.now(), skewMs = SKEW_MS) {
  if (!session?.accessToken || !session?.expiresAt) return false;
  return Number(session.expiresAt) - skewMs > now;
}

// Prefer a still-valid access token, then a refresh token, then email and password.
export async function ensureWorkerSession({ fetchImpl, backendUrl, apiKey, email, password, stored, now = Date.now() }) {
  if (accessTokenFresh(stored, now)) return { ...stored, ok: true, refreshed: false };
  if (stored?.refreshToken) {
    const refreshed = await refreshAccessToken({
      fetchImpl,
      backendUrl,
      apiKey,
      refreshToken: stored.refreshToken,
      now,
    });
    if (refreshed.ok) return { ...refreshed, refreshed: true };
  }
  if (email && password) {
    const signed = await signInWithPassword({ fetchImpl, backendUrl, apiKey, email, password, now });
    if (signed.ok) return { ...signed, refreshed: true };
    return signed;
  }
  return { ok: false, error: "sign_in_required" };
}
