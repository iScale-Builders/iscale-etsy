// URL-keyed scrape queue (the "smarter" model).
//
// The old queue stored one `listing_urls` row per (job, URL): a popular listing
// got a separate row in every run that discovered it, which forced display
// de-dup, multi-row removes, orphaned-row buildup, and per-job resume bookkeeping.
//
// This model stores ONE canonical row per normalized URL:
//   { id, url, normalizedUrl, listingId, status, terms[], term, searchTerm,
//     page, source, firstSeenAt, updatedAt, reason }
// - `terms[]` accumulates every search term that surfaced the URL (a multiEntry
//   index lets the runner fetch "pending URLs for term T" without a full scan).
// - `term`/`searchTerm` mirror the primary (first-seen) term for display/back-compat.
// - one row per URL ⇒ the remaining list is inherently unique, remove is one row,
//   and the once-per-day rule is a single status/`lastVisitedAt` check.
//
// Pure + unit-tested. The background wiring (discovery/visit/resume/migration)
// delegates to these helpers.

import { normalizeEtsyListingUrl, extractListingId } from "./etsy-url.js";
import { hashText } from "./hash.js";

// Canonical key for a URL's queue row — derived from the NORMALIZED url so the
// same listing (tracking params, slug variations) collapses to one row.
export function urlQueueId(url) {
  return `q_${hashText(normalizeEtsyListingUrl(url) || url || "")}`;
}

function uniqueTerms(...lists) {
  return Array.from(new Set(lists.flat().filter((t) => t != null && t !== "")));
}

function lowestPage(...pages) {
  const valid = pages.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return valid.length ? Math.min(...valid) : null;
}

// Merge a freshly discovered URL into its (possibly existing) queue row. The row
// is (re)queued as PENDING — callers decide whether to queue at all (e.g. skip
// when already scraped today). Unions the surfacing terms, keeps the lowest page.
export function mergeQueueDiscovery(existing, { url, term, page, source } = {}, nowIso) {
  const norm = normalizeEtsyListingUrl(url) || url || "";
  const terms = uniqueTerms(existing?.terms, term);
  const primary = terms[0] || existing?.term || "";
  return {
    id: urlQueueId(norm),
    url: norm,
    normalizedUrl: norm,
    listingId: extractListingId(norm) || existing?.listingId || "",
    status: "pending",
    terms,
    term: primary,
    searchTerm: primary,
    page: lowestPage(existing?.page, page),
    source: existing?.source || source || "batch",
    firstSeenAt: existing?.firstSeenAt || nowIso,
    updatedAt: nowIso,
    reason: "",
  };
}

// Add a term association to an existing row WITHOUT changing its status (used
// when a not-to-be-requeued URL — done today, or being visited — is surfaced
// again by another term). Returns the same row if the term is already present.
export function addTermToRow(row, term, nowIso) {
  if (!term || (row.terms || []).includes(term)) return row;
  const terms = uniqueTerms(row.terms, term);
  return { ...row, terms, term: row.term || terms[0], searchTerm: row.searchTerm || terms[0], updatedAt: nowIso };
}

// "Most advanced" status wins when collapsing duplicate legacy rows for one URL:
// a URL scraped (done) in any run is done; else if anything was queued it's
// pending; only all-failed stays failed. "processing" collapses to pending
// (an interrupted visit must be retried, never left mid-flight).
const STATUS_RANK = { done: 3, processing: 2, pending: 2, failed: 1 };
function rankStatus(status) {
  const s = status === "processing" ? "pending" : status;
  return { s, rank: STATUS_RANK[s] || 0 };
}

// Collapse legacy per-(job,URL) `listing_urls` rows into one row per URL. Used
// once by the migration. `oldRows` are the legacy rows; returns new canonical rows.
export function collapseQueueRows(oldRows, nowIso) {
  const byKey = new Map();
  for (const r of Array.isArray(oldRows) ? oldRows : []) {
    if (!r || !r.url) continue;
    const norm = normalizeEtsyListingUrl(r.url) || r.url;
    const key = urlQueueId(norm);
    const prev = byKey.get(key);
    const { s: incomingStatus, rank } = rankStatus(r.status || "pending");
    const status = !prev || rank > (STATUS_RANK[prev.status] || 0) ? incomingStatus : prev.status;
    const stamps = [prev?.firstSeenAt, r.createdAt, r.updatedAt].filter(Boolean).sort();
    const terms = uniqueTerms(prev?.terms, r.searchTerm);
    byKey.set(key, {
      id: key,
      url: norm,
      normalizedUrl: norm,
      listingId: extractListingId(norm) || prev?.listingId || "",
      status: status || "pending",
      terms,
      term: terms[0] || "",
      searchTerm: terms[0] || "",
      page: lowestPage(prev?.page, r.page),
      source: prev?.source || r.source || "batch",
      firstSeenAt: stamps[0] || nowIso,
      updatedAt: nowIso,
      reason: "",
    });
  }
  return [...byKey.values()];
}

// Is a legacy (per-job) row? Legacy ids look like `url_<jobId>_<hash>`; canonical
// rows look like `q_<hash>`. Drives the one-time, idempotent migration.
export function isLegacyQueueRow(row) {
  return !!row && typeof row.id === "string" && row.id.startsWith("url_");
}
