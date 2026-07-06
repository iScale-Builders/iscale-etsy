// Pure helpers for the live collection dashboard, toolbar badge, and auto-export.

export const DEFAULT_SETTINGS = {
  autoExportEnabled: true, // master on/off toggle for auto-download
  autoExportEvery: 500, // auto-download a full CSV snapshot every N new listings
  clearAfterExport: false, // wipe the collection after each (auto) download — keeps storage small
  downloadSubfolder: "", // optional Downloads subfolder for CSV exports ("" = root)
  lastExportTotal: 0, // total listing count at the last auto-export
  autoRunEnabled: false, // master on/off toggle for the interval auto-run
  searchIntervalMin: 30, // PER-LISTING interval ("Every N sec" countdown), stored in minutes
  betweenTermsSec: 0, // BETWEEN TERMS: extra pause (sec) before moving to the next term; 0 = off
  randomizeInterval: false, // jitter the interval ±randomizePct each cycle
  randomizePct: 40, // jitter percentage (0–95) when randomizeInterval is on
  queuePagesPerTerm: 10, // pages per term for queued/interval runs
  autoRetryFailed: 2, // when auto-run has no new work, re-visit FAILED URLs up to this many times each (0 = off)
  blockCooldownMin: 30, // after the circuit breaker trips (Etsy block), pause NEW auto-run cycles this long
  blockedUntil: 0, // epoch ms until which auto-run stays in post-block cooldown (0 = none)
  manualFirstReview: false, // opt-in: also extract first-review (opens the reviews
  // modal) when manually browsing a listing page. Off by default so casual
  // browsing isn't interrupted by the reviews popup.
};

// Is interval auto-run effectively on? Toggle on AND a positive interval. Falls
// back to the legacy "interval > 0 means on" rule for settings saved before the
// toggle existed.
export function autoRunOn(settings = {}) {
  const minutes = Number(settings.searchIntervalMin) || 0;
  const enabled = settings.autoRunEnabled ?? minutes > 0;
  return enabled && minutes > 0;
}

// Effective auto-run interval in minutes (0 when off).
export function autoRunMinutes(settings = {}) {
  return autoRunOn(settings) ? Number(settings.searchIntervalMin) || 0 : 0;
}

// The next cycle's wait in minutes, jittered ±randomizePct around the base
// interval when randomizeInterval is on, so the cadence isn't robotic.
// Returns the base interval when randomize is off, 0 when auto-run is off.
// `rand` is injectable for deterministic tests; defaults to Math.random.
export function jitteredAutoRunMinutes(settings = {}, rand = Math.random) {
  const base = autoRunMinutes(settings);
  if (base <= 0 || !settings.randomizeInterval) return base;
  const pct = Math.max(0, Math.min(95, Number(settings.randomizePct) || 0)) / 100;
  const min = base * (1 - pct);
  const max = base * (1 + pct);
  return min + rand() * (max - min);
}


// BETWEEN TERMS: the extra pause (ms) before the runner moves to the NEXT search term.
// Independent of the per-listing interval — its own setting. 0 = off (no pause).
export function betweenTermsMs(settings = {}) {
  return Math.max(0, Number(settings.betweenTermsSec) || 0) * 1000;
}

// The between-terms pause, jittered ±randomizePct when the (shared) randomize toggle is on
// — so the gap between terms isn't a robotic fixed value. Mirrors jitteredAutoRunMinutes;
// reuses the same randomizeInterval/randomizePct the per-listing interval uses. Returns the
// base when randomize is off or the pause is 0. `rand` injectable for tests. (between-terms randomizer)
export function jitteredBetweenTermsMs(settings = {}, rand = Math.random) {
  const base = betweenTermsMs(settings);
  if (base <= 0 || !settings.randomizeInterval) return base;
  const pct = Math.max(0, Math.min(95, Number(settings.randomizePct) || 0)) / 100;
  const min = base * (1 - pct);
  const max = base * (1 + pct);
  return Math.round(min + rand() * (max - min));
}

// POST-BLOCK COOLDOWN: when the circuit breaker trips (Etsy blocking/logged-out), we stamp
// settings.blockedUntil = now + this, and AUTO-RUN skips starting NEW cycles until it
// elapses — so we never re-hammer a block (prevention-first). Manual ▶ Run bypasses it.
export function blockCooldownMs(settings = {}) {
  return Math.max(0, Number(settings.blockCooldownMin) || 0) * 60000;
}

// Is auto-run currently in post-block cooldown? True only while a future blockedUntil
// deadline hasn't passed.
export function inBlockCooldown(settings = {}, nowMs = Date.now()) {
  const until = Number(settings.blockedUntil) || 0;
  return until > 0 && nowMs < until;
}

// Is auto-download effectively on? Toggle on (default on for legacy settings)
// AND a positive threshold.
export function autoExportOn(settings = {}) {
  return settings.autoExportEnabled !== false && (Number(settings.autoExportEvery) || 0) > 0;
}

// Toolbar badge text: "" when empty, plain up to 999, then "1k".."99k", capped.
export function formatBadgeCount(n) {
  const value = Number(n) || 0;
  if (value <= 0) return "";
  if (value < 1000) return String(value);
  if (value < 100000) return `${Math.floor(value / 1000)}k`;
  return "99k+";
}

// New listings since the last auto-export.
export function newSinceExport(total, lastExportTotal) {
  return Math.max(0, (Number(total) || 0) - (Number(lastExportTotal) || 0));
}

// Should we fire an auto-export now? Fires when the collected count CROSSES a round
// multiple of `every` (500, 1000, 1500, …) since the last export. Anchoring to round
// multiples of the count — rather than to the last export's ragged total — keeps the
// cadence aligned with the visible "X collected" number. Batched captures (a search
// page adds ~48 at once) used to drift the threshold off the round numbers.
export function shouldAutoExport(total, settings = {}) {
  if (!autoExportOn(settings)) return false;
  const every = Number(settings.autoExportEvery) || 0;
  if (every <= 0) return false;
  const t = Number(total) || 0;
  const last = Number(settings.lastExportTotal) || 0;
  return Math.floor(t / every) > Math.floor(last / every);
}

// Listings remaining until the next auto-export (null when disabled). Counts down to
// the next round multiple of `every` based on the collected total — so it matches the
// "X collected" number (e.g. 1431 collected, every 500 → 69 until 1500).
export function untilNextExport(total, settings = {}) {
  if (!autoExportOn(settings)) return null;
  const every = Number(settings.autoExportEvery) || 0;
  if (every <= 0) return null;
  return every - ((Number(total) || 0) % every);
}

// Compact feed item for the live dashboard stream.
export function feedItem(listing = {}, nowIso) {
  return {
    id: listing.id || listing.listingId || listing.url,
    title: listing.title || "Untitled",
    url: listing.url || "",
    demandText: listing.demandText || "",
    demandValue: Number(listing.demandValue) || 0,
    isDigital: listing.isDigital === true ? true : listing.isDigital === false ? false : null,
    source: listing.source || "",
    at: nowIso || listing.scrapedAt || listing.lastSeenAt || "",
  };
}
