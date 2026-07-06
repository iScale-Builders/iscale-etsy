import { csvToRows, splitCsvList } from "./csv.js";
import { mergeListing } from "./dedupe.js";
import { coerceDemandHistory } from "./demand-history.js";
import { extractListingId, normalizeEtsyListingUrl } from "./etsy-url.js";
import { hashText } from "./hash.js";

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function toBool(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes";
}

// Normalize a count that may carry locale thousands separators (e.g. a hosted-
// shop CSV with "1,234"); a plain digit/comma string becomes "1234" so the
// numeric merge (pickPositive -> Number) doesn't read it as 0. (audit LOW)
function cleanNumeric(value) {
  const text = String(value ?? "").trim();
  return /^\d[\d,]*$/.test(text) ? text.replace(/,/g, "") : value;
}

// Map a parsed CSV row (v5 camelCase OR hosted-shop snake_case) into a v5
// listing record, parsing demand_history JSON and the accumulating fields.
export function rowsFromImportedCsv(text, importedAt = new Date().toISOString()) {
  return csvToRows(text).flatMap((row) => {
    const normalizedUrl = normalizeEtsyListingUrl(row.url || row.normalizedUrl || row.listing_url || "");
    const listingId = row.listingId || row.listing_id || extractListingId(normalizedUrl || row.url || "");
    if (!normalizedUrl && !listingId) return [];
    const lastScrapedAt = firstDefined(row.lastScrapedAt, row.last_scraped_at, row.scrapedAt, row.lastSeenAt, row.updated_at);
    const now = lastScrapedAt || importedAt;
    const deleted = toBool(firstDefined(row.deleted, false));

    return {
      ...row,
      id: row.id || `listing_${listingId || hashText(normalizedUrl)}`,
      url: normalizedUrl || row.url || row.normalizedUrl,
      normalizedUrl: normalizedUrl || row.normalizedUrl || row.url,
      listingId: listingId || "",
      title: firstDefined(row.title) ?? "",
      shopName: firstDefined(row.shopName, row.shop_name) ?? "",
      imageUrl: firstDefined(row.imageUrl, row.image_url, row.image) ?? "",
      demandText: firstDefined(row.demandText, row.info, row.demand_text) ?? "",
      demandType: firstDefined(row.demandType, row.demand_type) ?? "",
      demandValue: cleanNumeric(firstDefined(row.demandValue, row.demand_value) ?? ""),
      demandHistory: coerceDemandHistory(firstDefined(row.demandHistory, row.demand_history)),
      favorites: cleanNumeric(firstDefined(row.favorites) ?? ""),
      reviewCount: cleanNumeric(firstDefined(row.reviewCount, row.review_count) ?? ""),
      firstReview: firstDefined(row.firstReview, row.first_review) ?? "",
      lastReview: firstDefined(row.lastReview, row.last_review) ?? "",
      isDigital: firstDefined(row.isDigital, row.is_digital) ?? "",
      deleted,
      deletedAt: firstDefined(row.deletedAt, row.deleted_at) ?? "",
      source: row.source || "csv_import",
      // Restore the accumulated term/source history so an exported-then-reimported
      // row keeps every keyword that ever found it (mergeListing unions these).
      searchTerm: firstDefined(row.searchTerm, row.search_term) ?? "",
      searchTerms: splitCsvList(firstDefined(row.searchTerms, row.search_terms)),
      sources: splitCsvList(row.sources),
      importedAt,
      // Don't derive firstSeenAt from a (possibly much later) lastScrapedAt — fall
      // back to import time, the real local "first seen", not the scrape time. (M-5)
      firstSeenAt: row.firstSeenAt || importedAt,
      lastSeenAt: row.lastSeenAt || now,
      scrapedAt: row.scrapedAt || now,
      lastScrapedAt: now,
    };
  });
}

export function mergeImportedListings(existingRows, importedRows) {
  // Index existing rows by their REAL primary key (`id`) so none is ever silently dropped,
  // plus a url->id map so an imported row finds its existing match by URL. If two EXISTING
  // rows share a normalized URL but have different ids (e.g. a hash-id hosted-shop import
  // and a native `listing_<id>` scrape of the same listing), collapse them into the
  // canonical id, merge their data, and report the loser id in `removedIds` so the caller
  // can delete the orphan (it would otherwise linger in IndexedDB and inflate counts).
  // (audit M-1)
  const byId = new Map();
  const urlToId = new Map();
  const removedIds = [];

  const linkUrl = (id) => {
    const url = importKey(byId.get(id));
    if (!url) return;
    const prevId = urlToId.get(url);
    if (prevId === undefined || prevId === id) {
      urlToId.set(url, id);
      return;
    }
    const winner = pickCanonicalId(prevId, id);
    const loser = winner === prevId ? id : prevId;
    byId.set(winner, { ...mergeListing(byId.get(winner), byId.get(loser)), id: winner });
    byId.delete(loser);
    removedIds.push(loser);
    urlToId.set(url, winner);
  };

  for (const row of Array.isArray(existingRows) ? existingRows : []) {
    if (!row) continue;
    const id = row.id || (importKey(row) ? `k:${importKey(row)}` : null);
    if (!id) continue;
    byId.set(id, row);
  }
  for (const id of [...byId.keys()]) linkUrl(id);

  let added = 0;
  let updated = 0;
  for (const row of Array.isArray(importedRows) ? importedRows : []) {
    const url = importKey(row);
    if (!url) continue;
    const existingId = urlToId.get(url);
    if (existingId !== undefined) {
      byId.set(existingId, { ...mergeListing(byId.get(existingId), row), id: existingId });
      updated++;
    } else {
      const id = row.id || `k:${url}`;
      byId.set(id, row);
      urlToId.set(url, id);
      added++;
    }
  }

  return {
    rows: Array.from(byId.values()),
    added,
    updated,
    imported: added + updated,
    removedIds,
  };
}

// Prefer a native `listing_<numericId>` id over a hash-derived one when collapsing two
// rows for the same URL; otherwise keep the first-seen id (stable).
function pickCanonicalId(a, b) {
  const ca = /^listing_\d+$/.test(String(a || ""));
  const cb = /^listing_\d+$/.test(String(b || ""));
  if (ca && !cb) return a;
  if (cb && !ca) return b;
  return a;
}

function importKey(row) {
  return normalizeEtsyListingUrl(row?.url || row?.normalizedUrl || "") || (row?.listingId ? `listing:${row.listingId}` : null);
}

