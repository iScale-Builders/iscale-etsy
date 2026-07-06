import { normalizeEtsyListingUrl } from "./etsy-url.js";
import { appendDemandHistory, coerceDemandHistory, unionDemandHistory } from "./demand-history.js";

export function listingKey(row) {
  const normalized = normalizeEtsyListingUrl(row?.url || row?.normalizedUrl || "");
  if (normalized) return normalized;
  if (row?.listingId) return `listing:${row.listingId}`;
  return null;
}

function present(value) {
  return value !== undefined && value !== null && value !== "";
}

function epoch(value) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function looksLikeRealDate(value) {
  return typeof value === "string" && value !== "None" && value !== "N/A" && value !== "" && /\d/.test(value);
}

function union(...lists) {
  return Array.from(new Set(lists.flat().filter(Boolean)));
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// For counts (favorites/reviews/demand value): a fresh scrape that returns 0
// usually means Etsy didn't render the block, not that the real value dropped to
// 0 — so never let a 0/blank overwrite an existing positive value.
function pickPositive(newerVal, olderVal) {
  if (toNum(newerVal) > 0) return newerVal;
  if (toNum(olderVal) > 0) return olderVal;
  return present(newerVal) ? newerVal : olderVal;
}

function earliest(a, b) {
  if (a && b) return epoch(a) <= epoch(b) ? a : b;
  return a || b || "";
}

// Snake_case aliases (from hosted-shop CSV imports) that must not survive the
// merge spread as stale duplicates of their canonical camelCase fields.
const SNAKE_ALIASES = [
  "demand_history", "demand_value", "demand_type", "review_count", "first_review",
  "last_review", "is_digital", "shop_name", "image_url", "last_scraped_at",
  "deleted_at", "updated_at", "info",
];

// Merge two records for the same listing.
//   opts.observe === true  -> treat `incoming` as a fresh scrape: append a new
//                             demand_history entry (in-place if <1h old).
//   opts.observe === false -> combine two stored snapshots (CSV import/dedupe):
//                             union their demand histories.
// In both cases the newer record (by scrape time) wins scalar fields, deleted
// state is preserved, and a real first_review is never clobbered by a blank.
export function mergeListing(existing, incoming, opts = {}) {
  const now = opts.nowIso || incoming.scrapedAt || incoming.lastSeenAt || new Date().toISOString();
  const observe = opts.observe === true;

  const existingHistory = coerceDemandHistory(existing.demandHistory ?? existing.demand_history);
  const incomingHistory = coerceDemandHistory(incoming.demandHistory ?? incoming.demand_history);

  const incTime = observe ? Infinity : epoch(incoming.lastScrapedAt || incoming.scrapedAt || incoming.lastSeenAt);
  const exTime = epoch(existing.lastScrapedAt || existing.scrapedAt || existing.lastSeenAt);
  // On a tie (equal or missing timestamps) prefer the existing record so a blank
  // incoming snapshot can't win and wipe fields.
  const newer = incTime > exTime ? incoming : existing;
  const older = newer === incoming ? existing : incoming;
  const pick = (field) => (present(newer[field]) ? newer[field] : older[field]);

  const demandHistory = observe
    ? appendDemandHistory(existingHistory, { value: incoming.demandValue, type: incoming.demandType, info: incoming.demandText }, now)
    : unionDemandHistory(existingHistory, incomingHistory);

  // Preserve a real first_review if the newer record lost it.
  let firstReview = pick("firstReview");
  if (!looksLikeRealDate(firstReview)) {
    if (looksLikeRealDate(existing.firstReview)) firstReview = existing.firstReview;
    else if (looksLikeRealDate(incoming.firstReview)) firstReview = incoming.firstReview;
  }

  // Same salvage for last_review: a blank/"None" rescrape (Etsy didn't render the
  // reviews block) must not erase a real last-review date. Prefer the newer real
  // date when present, else keep whichever side still has one.
  let lastReview = pick("lastReview");
  if (!looksLikeRealDate(lastReview)) {
    if (looksLikeRealDate(existing.lastReview)) lastReview = existing.lastReview;
    else if (looksLikeRealDate(incoming.lastReview)) lastReview = incoming.lastReview;
  }

  const deleted = present(newer.deleted) ? newer.deleted === true || newer.deleted === "true" : existing.deleted === true;
  // A non-deleted (resurrected) listing must not keep a stale deletion timestamp.
  const deletedAt = deleted ? existing.deletedAt || incoming.deletedAt || now : "";

  const scrapedAt = observe ? now : pick("scrapedAt") || now;

  // Accumulate every source/term that ever found this listing — from the arrays
  // on both sides AND the scalar on each (so a re-scrape or an imported row that
  // only carries the scalar still contributes). The scalar then prefers the
  // newer non-empty value, falling back to the accumulated list so a termless
  // capture (e.g. a direct listing-page visit) can never blank a real term.
  const sources = union(existing.sources, incoming.sources, [existing.source, incoming.source]);
  const searchTerms = union(existing.searchTerms, incoming.searchTerms, [existing.searchTerm, incoming.searchTerm]);

  const merged = {
    ...existing,
    ...incoming,
    // Keep the existing record's primary key so an import row (whose id may be a
    // URL-hash fallback when it carried no listingId) can't flip the id and leave
    // the original row orphaned under its old key on bulkPut. (audit M-1)
    id: existing.id || incoming.id,
    title: pick("title"),
    price: pick("price"),
    priceNumeric: pick("priceNumeric"),
    currency: pick("currency"),
    imageUrl: pick("imageUrl"),
    shopName: pick("shopName"),
    isDigital: present(newer.isDigital) ? newer.isDigital : older.isDigital,
    demandText: pick("demandText"),
    demandType: pick("demandType"),
    demandValue: pickPositive(newer.demandValue, older.demandValue),
    demandHistory,
    favorites: pickPositive(newer.favorites, older.favorites),
    reviewCount: pickPositive(newer.reviewCount, older.reviewCount),
    firstReview,
    lastReview,
    deleted,
    deletedAt,
    firstSeenAt: earliest(existing.firstSeenAt, incoming.firstSeenAt) || now,
    lastSeenAt: now,
    scrapedAt,
    lastScrapedAt: observe ? now : pick("lastScrapedAt") || scrapedAt,
    updatedAt: now,
    source: pick("source") || sources[0] || "",
    sources,
    searchTerm: pick("searchTerm") || searchTerms[0] || "",
    searchTerms,
  };
  // Drop stale snake_case duplicates that came in via the incoming spread.
  for (const key of SNAKE_ALIASES) delete merged[key];
  return merged;
}

// Record a fresh scrape observation against an existing stored record (or null).
export function recordScrape(existing, incoming, nowIso) {
  const now = nowIso || incoming.scrapedAt || new Date().toISOString();
  if (!existing) {
    const history = appendDemandHistory(coerceDemandHistory(incoming.demandHistory), {
      value: incoming.demandValue,
      type: incoming.demandType,
      info: incoming.demandText,
    }, now);
    return {
      ...incoming,
      demandHistory: history,
      // Seed the accumulation arrays from the scalars so even a first-seen row
      // carries its source/term in `sources`/`searchTerms` (and the CSV).
      sources: union(incoming.sources, [incoming.source]),
      searchTerms: union(incoming.searchTerms, [incoming.searchTerm]),
      firstSeenAt: incoming.firstSeenAt || now,
      lastSeenAt: now,
      scrapedAt: now,
      lastScrapedAt: now,
      updatedAt: now,
    };
  }
  return mergeListing(existing, incoming, { observe: true, nowIso: now });
}

// True when an ISO timestamp falls on the same LOCAL calendar day as nowMs.
// Drives once-per-day scraping: a listing already scraped today is not re-scraped
// until the date changes (after which it counts as a fresh scrape).
// NOTE: LOCAL time is intentional here ("today" from the operator's point of
// view). This deliberately differs from extract-listing.js parseValidReviewDate,
// which is built on UTC so stored dates never shift with the runner's timezone.
// Do not "align" one to the other — they answer different questions.
export function sameCalendarDay(iso, nowMs) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return false;
  const a = new Date(t);
  const b = new Date(nowMs);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function dedupeListings(rows) {
  const merged = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = listingKey(row);
    if (!key) continue;
    const normalizedUrl = normalizeEtsyListingUrl(row.url) || row.url;
    const next = { ...row, normalizedUrl };
    merged.set(key, merged.has(key) ? mergeListing(merged.get(key), next) : next);
  }
  return Array.from(merged.values());
}
