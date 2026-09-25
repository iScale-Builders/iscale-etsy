// Settings and lane-snapshot helpers for the optional backend worker.
// Worker mode is off until a person turns it on and supplies their own backend.
// Nothing here is a URL, key, or lane name.

import { classifyApiKey } from "./worker-auth.js";

export const LANE_SESSION_KEY = "etsyWorkerLane";

export const WORKER_DEFAULTS = {
  workerEnabled: false,
  workerBackendUrl: "",
  workerAnonKey: "",
  workerLaneName: "",
  workerLeaseSeconds: 180,
  workerPollSeconds: 20,
  workerHeartbeatSeconds: 30,
  workerPaceMinMs: 4000,
  workerPaceMaxMs: 9000,
  workerKeystrokeMinMs: 40,
  workerKeystrokeMaxMs: 140,
  workerBlockBackoffMin: 30,
  workerBetweenJobsMinMs: 20000,
  workerBetweenJobsMaxMs: 60000,
  workerJobsPerHour: 30,
  workerEmail: "",
  workerRealtime: true,
  workerBlockedUntil: 0,
};

// Chrome will not fire a packed-extension alarm faster than this. An idle lane
// still starts a newly queued term inside the two-minute budget at the default poll.
export const ALARM_FLOOR_SECONDS = 30;
export const IDLE_PICKUP_SLA_MS = 2 * 60 * 1000;

const LANE_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function normalizeBackendUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "missing_backend_url" };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "invalid_backend_url" };
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return { ok: false, error: "https_required" };
  }
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/rest\/v1$/, "");
  const base = `${url.origin}${path === "/" ? "" : path}`;
  return { ok: true, base, origin: url.origin, hostPermission: `${url.origin}/*` };
}

export function normalizeLaneName(raw) {
  const laneName = String(raw || "").trim().replace(/\s+/g, " ");
  if (!LANE_RE.test(laneName)) return { ok: false, error: "invalid_lane_name" };
  return { ok: true, laneName };
}

export function normalizeWorkerSettings(settings = {}) {
  const merged = { ...WORKER_DEFAULTS, ...settings };
  const backend = normalizeBackendUrl(merged.workerBackendUrl);
  const lane = normalizeLaneName(merged.workerLaneName);
  const enabled = merged.workerEnabled === true;
  const keyCheck = classifyApiKey(merged.workerAnonKey);
  const anonKey = keyCheck.ok ? keyCheck.key : "";
  const paceMinMs = clampInt(merged.workerPaceMinMs, 500, 120000, WORKER_DEFAULTS.workerPaceMinMs);
  const betweenJobsMinMs = clampInt(merged.workerBetweenJobsMinMs, 0, 600000, WORKER_DEFAULTS.workerBetweenJobsMinMs);
  const betweenJobsMaxMs = Math.max(
    betweenJobsMinMs,
    clampInt(merged.workerBetweenJobsMaxMs, 0, 600000, WORKER_DEFAULTS.workerBetweenJobsMaxMs),
  );
  const paceMaxMs = Math.max(paceMinMs, clampInt(merged.workerPaceMaxMs, 500, 120000, WORKER_DEFAULTS.workerPaceMaxMs));
  const keystrokeMinMs = clampInt(merged.workerKeystrokeMinMs, 10, 1000, WORKER_DEFAULTS.workerKeystrokeMinMs);
  const keystrokeMaxMs = Math.max(
    keystrokeMinMs,
    clampInt(merged.workerKeystrokeMaxMs, 10, 2000, WORKER_DEFAULTS.workerKeystrokeMaxMs),
  );
  const email = String(merged.workerEmail || "").trim();
  const ready = enabled && backend.ok && lane.ok && keyCheck.ok;
  let configError = null;
  if (enabled && !ready) {
    if (!backend.ok) configError = backend.error;
    else if (!keyCheck.ok) configError = keyCheck.error;
    else configError = lane.error;
  }
  return {
    enabled,
    ready,
    configError,
    backendUrl: backend.ok ? backend.base : "",
    origin: backend.ok ? backend.origin : "",
    hostPermission: backend.ok ? backend.hostPermission : "",
    anonKey,
    keyKind: keyCheck.ok ? keyCheck.kind : "",
    email,
    laneName: lane.ok ? lane.laneName : "",
    leaseSeconds: clampInt(merged.workerLeaseSeconds, 30, 3600, WORKER_DEFAULTS.workerLeaseSeconds),
    pollSeconds: clampInt(merged.workerPollSeconds, 5, 120, WORKER_DEFAULTS.workerPollSeconds),
    heartbeatSeconds: clampInt(merged.workerHeartbeatSeconds, 10, 300, WORKER_DEFAULTS.workerHeartbeatSeconds),
    paceMinMs,
    paceMaxMs,
    keystrokeMinMs,
    keystrokeMaxMs,
    blockBackoffMin: clampInt(merged.workerBlockBackoffMin, 1, 240, WORKER_DEFAULTS.workerBlockBackoffMin),
    betweenJobsMinMs,
    betweenJobsMaxMs,
    jobsPerHour: clampInt(merged.workerJobsPerHour, 1, 500, WORKER_DEFAULTS.workerJobsPerHour),
    realtime: merged.workerRealtime !== false,
    blockedUntil: Number(merged.workerBlockedUntil) || 0,
  };
}

export function workerAlarmDelayMinutes(pollSeconds) {
  const seconds = clampInt(pollSeconds, 5, 120, WORKER_DEFAULTS.workerPollSeconds);
  return Math.max(ALARM_FLOOR_SECONDS / 60, seconds / 60);
}

// Worst case for an asleep lane: one alarm interval (never below Chrome's floor).
export function idlePickupWithinSla(pollSeconds, alarmFloorSeconds = ALARM_FLOOR_SECONDS) {
  const waitMs = Math.max(Number(alarmFloorSeconds) || 0, Number(pollSeconds) || 0) * 1000;
  return waitMs <= IDLE_PICKUP_SLA_MS;
}

const SNAPSHOT_KEYS = [
  "laneName",
  "status",
  "phase",
  "jobId",
  "term",
  "page",
  "pages",
  "listingsUploaded",
  "totalResults",
  "totalResultsRaw",
  "searchPath",
  "lastError",
  "updatedAt",
  "backendHost",
];

const WORKER_SECRET_KEYS = [
  "workerAnonKey",
  "workerPassword",
  "workerAccessToken",
  "workerRefreshToken",
];

// Content scripts may read settings for browsing preferences. They must not
// receive the backend key, password, or auth tokens.
export function redactWorkerCredentials(settings) {
  const copy = { ...(settings || {}) };
  for (const key of Object.keys(copy)) {
    if (key.startsWith("worker") || WORKER_SECRET_KEYS.includes(key)) delete copy[key];
  }
  return copy;
}

export function sanitizeLaneSnapshot(partial) {
  const src = partial && typeof partial === "object" ? partial : {};
  const out = {};
  for (const key of SNAPSHOT_KEYS) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}
