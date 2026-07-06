// Accumulates a per-listing demand history across repeated scrapes:
// newest entry first, an entry younger than 1 hour is updated in place rather
// than duplicated, and the array is capped at 30 entries. The shop cards cycle
// through these entries. Pure + unit-tested.

export const MAX_DEMAND_HISTORY = 30;
const ONE_HOUR_MS = 3600000;

function toInt(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : 0;
  const match = String(value ?? "").replace(/[,+]/g, "").match(/-?\d+/);
  return match ? Number.parseInt(match[0], 10) : 0;
}

export function makeDemandEntry({ value, type, info } = {}, nowIso) {
  const now = nowIso || new Date().toISOString();
  return {
    date: now.split("T")[0],
    timestamp: now,
    created_at: now,
    value: toInt(value),
    type: type || null,
    info: info || null,
  };
}

// Append a fresh scrape observation. If the most recent entry is younger than an
// hour, replace it in place (keeping its original created_at); otherwise unshift
// a new entry. Returns a new array — does not mutate `existing`.
export function appendDemandHistory(existing, observation = {}, nowIso) {
  const now = nowIso || new Date().toISOString();
  const today = now.split("T")[0];
  const history = Array.isArray(existing) ? existing.map((entry) => ({ ...entry })) : [];

  const value = toInt(observation.value);
  const type = observation.type || null;
  const info = observation.info || null;

  const mostRecent = history[0];
  const createdAt = mostRecent?.created_at || mostRecent?.timestamp || null;
  // Compare epochs, not ISO strings — string compare breaks on non-Z / offset /
  // differing-precision timestamps (e.g. from imported hosted-shop CSVs).
  const cutoff = Date.parse(now) - ONE_HOUR_MS;

  if (mostRecent && createdAt && Date.parse(createdAt) > cutoff) {
    // In-place update of the same <1h observation: a blank re-scrape (Etsy didn't render
    // the demand text this time) must NOT wipe a real value/type/info already captured in
    // this window. Preserve the positive/non-empty prior fields. (audit LOW-11)
    history[0] = {
      date: today,
      timestamp: now,
      created_at: createdAt,
      value: value > 0 ? value : mostRecent.value,
      type: type || mostRecent.type || null,
      info: info || mostRecent.info || null,
    };
  } else {
    history.unshift({ date: today, timestamp: now, created_at: now, value, type, info });
  }

  return history.length > MAX_DEMAND_HISTORY ? history.slice(0, MAX_DEMAND_HISTORY) : history;
}

// Merge two stored histories (e.g. when importing/combining CSV snapshots).
// De-dupes by created_at (falling back to timestamp), keeps newest-first, caps.
export function unionDemandHistory(a, b) {
  const seen = new Set();
  const all = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
  const merged = [];
  all.forEach((entry, idx) => {
    if (!entry || typeof entry !== "object") return;
    // Keyless entries (no created_at/timestamp) get a unique key so distinct
    // observations are never collapsed together.
    const key = entry.created_at || entry.timestamp || `__keyless_${idx}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push({ ...entry });
  });
  merged.sort((x, y) => Date.parse(y.timestamp || y.created_at || 0) - Date.parse(x.timestamp || x.created_at || 0));
  return merged.slice(0, MAX_DEMAND_HISTORY);
}

// Parse a demand_history cell that may arrive from CSV as a JSON string.
export function coerceDemandHistory(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
