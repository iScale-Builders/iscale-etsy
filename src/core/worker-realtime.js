// Optional Supabase Realtime wake. Polling is the fallback and already meets
// the idle-lane budget; this only shortens it when the project publishes
// etsy_worker.jobs. The socket URL contains the caller's key — do not log it.

import { normalizeBackendUrl } from "./worker-config.js";

export function realtimeWebSocketUrl(backendUrl, apiKey) {
  const base = normalizeBackendUrl(backendUrl);
  if (!base.ok) throw new Error(base.error);
  const url = new URL(base.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/realtime/v1/websocket";
  url.searchParams.set("apikey", String(apiKey || ""));
  url.searchParams.set("vsn", "1.0.0");
  return url.toString();
}

export function realtimeJoinMessage(ref = "1", accessToken = "") {
  const payload = {
    config: {
      broadcast: { ack: false, self: false },
      presence: { enabled: false },
      postgres_changes: [
        { event: "INSERT", schema: "etsy_worker", table: "jobs" },
        { event: "UPDATE", schema: "etsy_worker", table: "jobs" },
      ],
    },
  };
  const token = String(accessToken || "");
  if (token && !token.startsWith("sb_publishable_") && !token.startsWith("sb_secret_")) {
    payload.access_token = token;
  }
  return {
    topic: "realtime:etsy_worker:jobs",
    event: "phx_join",
    payload,
    ref: String(ref),
  };
}

export function realtimeAccessTokenMessage(ref = "1", accessToken = "") {
  const token = String(accessToken || "");
  return {
    topic: "realtime:etsy_worker:jobs",
    event: "access_token",
    payload: token && !token.startsWith("sb_publishable_") && !token.startsWith("sb_secret_")
      ? { access_token: token }
      : {},
    ref: String(ref),
  };
}

export function realtimeHeartbeatMessage(ref = "hb") {
  return { topic: "phoenix", event: "heartbeat", payload: {}, ref: String(ref) };
}

export function parseRealtimeMessage(data) {
  if (data == null) return null;
  if (typeof data === "object") return data;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function isPendingJobWake(message) {
  if (!message || typeof message !== "object") return false;
  const data = message.payload?.data && typeof message.payload.data === "object"
    ? message.payload.data
    : message.payload;
  if (!data || typeof data !== "object") return false;
  const type = data.type || data.eventType;
  if (type !== "INSERT" && type !== "UPDATE") return false;
  const record = data.record || data.new || null;
  return record?.status === "pending";
}
