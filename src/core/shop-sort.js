// Pure model + query helpers behind the local Shop View. Normalizes
// heterogeneous rows (v5 camelCase scrapes or snake_case columns from older
// CSV exports), then applies consistent demand-value logic, demand-indicator
// cycling source, review-date parsing, sort keys (with NULLS-LAST +
// last_scraped_at tiebreak), chip/search/demand filters, URL de-duplication,
// and pagination. No DOM, no storage.

import { coerceDemandHistory } from "./demand-history.js";

export const SHOP_SORTS = ["newest", "demand", "reviews", "first_review", "price", "favorites"];
export const SHOP_CHIPS = ["all", "in_carts", "views", "selling_fast"];
export const SHOP_PAGE_SIZE = 100;

const SORT_SET = new Set(SHOP_SORTS);

export function toNumber(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const match = String(value).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : 0;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function toBoolOrNull(value) {
  if (value === true || value === false) return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "true" || text === "1" || text === "yes" || text === "digital") return true;
  if (text === "false" || text === "0" || text === "no" || text === "physical") return false;
  return null;
}

// Parse a raw price string ("$12.99", "1.234,50 €") to a number, or null.
export function parsePriceNumeric(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const match = String(value).match(/\d[\d.,]*/);
  if (!match) return null;
  let text = match[0];
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(text)) text = text.replace(/\./g, "").replace(",", ".");
  else if (/^\d+,\d{1,2}$/.test(text)) text = text.replace(",", ".");
  else text = text.replace(/,/g, "");
  const num = Number.parseFloat(text);
  return Number.isNaN(num) ? null : num;
}

// Accepts v5 (camelCase) or hosted-shop (snake_case) rows.
export function normalizeForShop(row = {}) {
  const info = firstDefined(row.demandText, row.info, row.demand_text);
  const price = firstDefined(row.price);
  const priceNumeric =
    row.priceNumeric != null && row.priceNumeric !== "" ? toNumber(row.priceNumeric) : parsePriceNumeric(price);
  const lastScrapedAt = firstDefined(row.lastScrapedAt, row.last_scraped_at, row.scrapedAt, row.lastSeenAt, row.updated_at, row.updatedAt);
  return {
    url: firstDefined(row.url, row.normalizedUrl, row.listing_url),
    listingId: firstDefined(row.listingId, row.listing_id),
    title: firstDefined(row.title) || "Untitled Product",
    shopName: firstDefined(row.shopName, row.shop_name),
    price,
    priceNumeric,
    imageUrl: firstDefined(row.imageUrl, row.image_url, row.image),
    isDigital: toBoolOrNull(firstDefined(row.isDigital, row.is_digital)),
    info,
    demandText: info,
    demandType: firstDefined(row.demandType, row.demand_type),
    demandValue: row.demandValue ?? row.demand_value ?? null,
    demandHistory: coerceDemandHistory(firstDefined(row.demandHistory, row.demand_history)),
    favorites: row.favorites != null && row.favorites !== "" ? toNumber(row.favorites) : 0,
    reviewCount: row.reviewCount != null ? toNumber(row.reviewCount) : row.review_count != null ? toNumber(row.review_count) : 0,
    firstReview: firstDefined(row.firstReview, row.first_review),
    lastReview: firstDefined(row.lastReview, row.last_review),
    source: firstDefined(row.source),
    searchTerm: firstDefined(row.searchTerm, row.search_term),
    deleted: toBoolOrNull(firstDefined(row.deleted, false)) === true,
    deletedAt: firstDefined(row.deletedAt, row.deleted_at),
    updatedAt: firstDefined(row.updatedAt, row.updated_at, lastScrapedAt),
    lastScrapedAt,
  };
}

// demand_value, falling back to the first integer in the demand text, then 0.
export function getDemandValue(row) {
  if (row.demandValue != null && row.demandValue !== "") {
    const val = Number(row.demandValue);
    if (!Number.isNaN(val)) return val;
  }
  const info = row.info || row.demandText || "";
  const match = String(info).match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

// ---- demand indicators (badge cycling source) ----

export function demandInfoMatchesFilter(info, filter) {
  if (!filter || filter === "all") return true;
  const lower = String(info || "").toLowerCase();
  switch (filter) {
    case "in_carts":
      return lower.includes("cart");
    case "views":
      return lower.includes("views");
    case "selling_fast":
      return (
        lower.includes("selling fast") ||
        lower.includes("sold") ||
        lower.includes("in demand") ||
        lower.includes("bought") ||
        lower.includes("people bought")
      );
    default:
      return true;
  }
}

export function getDemandIndicators(row, filter = "all") {
  const history = Array.isArray(row.demandHistory) ? row.demandHistory : [];
  if (history.length > 0) {
    let entries = history
      .filter((entry) => entry && entry.info)
      .map((entry) => ({ info: entry.info, timestamp: entry.timestamp || entry.date || entry.created_at || null }));
    if (filter && filter !== "all") {
      const matched = entries.filter((e) => demandInfoMatchesFilter(e.info, filter));
      if (matched.length > 0) entries = matched;
    }
    if (entries.length > 0) return entries;
  }
  if (!row.info) return [];
  return [{ info: row.info, timestamp: row.updatedAt || row.lastScrapedAt || null }];
}

// ---- review date parsing (mirrors shop.html parseReviewDate / SQL parser) ----

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// Build a timestamp only if (year, month1=1..12, day) is a real calendar date —
// rejects impossible inputs like 13/13/2026 instead of letting Date roll over.
function makeDate(year, month1, day) {
  if (month1 < 1 || month1 > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month1 - 1, day);
  return d.getFullYear() === year && d.getMonth() === month1 - 1 && d.getDate() === day ? d.getTime() : null;
}

// For DISPLAY: 0 = none, 1 = "LONG TIME AGO", else real ms timestamp.
export function parseReviewDate(dateStr) {
  if (!dateStr || dateStr === "N/A" || dateStr === "None") return 0;
  if (dateStr === "LONG TIME AGO") return 1;

  const iso = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return makeDate(+iso[1], +iso[2], +iso[3]) ?? 0;

  const text = dateStr.match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/);
  if (text && MONTHS[text[1]] !== undefined) return makeDate(+text[3], MONTHS[text[1]] + 1, +text[2]) ?? 0;

  const textEU = dateStr.match(/^(\d{1,2}) ([A-Z][a-z]{2}),? (\d{4})$/);
  if (textEU && MONTHS[textEU[2]] !== undefined) return makeDate(+textEU[3], MONTHS[textEU[2]] + 1, +textEU[1]) ?? 0;

  const num = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (num) {
    const a = +num[1];
    const b = +num[2];
    const year = +num[3];
    const hasLeadingZero = /^0\d$/.test(num[1]) || /^0\d$/.test(num[2]);
    const now = Date.now();
    if (a > 12) return makeDate(year, b, a) ?? 0; // DD/MM (a is the day)
    if (b > 12) return makeDate(year, a, b) ?? 0; // MM/DD (b is the day)
    const asUS = makeDate(year, a, b); // MM/DD
    const asEU = makeDate(year, b, a); // DD/MM
    if (asUS == null) return asEU ?? 0;
    if (asEU == null) return asUS;
    if (asUS > now && asEU <= now) return asEU;
    if (asEU > now && asUS <= now) return asUS;
    return hasLeadingZero ? asEU : asUS;
  }
  return 0;
}

export function formatReviewDate(dateStr) {
  if (!dateStr || dateStr === "N/A" || dateStr === "None") return dateStr;
  const ts = parseReviewDate(dateStr);
  if (!ts || ts === 1) return dateStr;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// For SORTING: null = no review (sorts last), else ms timestamp; LONG TIME AGO -> 1900.
function reviewDateSortKey(dateStr) {
  if (!dateStr || dateStr === "N/A" || dateStr === "None") return null;
  if (dateStr === "LONG TIME AGO") return new Date(1900, 0, 1).getTime();
  const ts = parseReviewDate(dateStr);
  return ts && ts !== 1 ? ts : null;
}

export function formatRelativeTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// ---- de-dupe (mirrors the RPC: one row per base URL, non-deleted + newest win) ----

function baseUrl(url) {
  return String(url || "")
    .split("?")[0]
    .replace(/\/+$/, "");
}

function epoch(value) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

export function dedupeForShop(rows) {
  const best = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = baseUrl(row.url) || row.listingId || row.url;
    if (!key) continue;
    const current = best.get(key);
    if (!current) {
      best.set(key, row);
      continue;
    }
    // Prefer non-deleted; among equal deleted-ness, prefer most recently scraped.
    const better =
      current.deleted !== row.deleted ? (row.deleted ? current : row) : epoch(row.lastScrapedAt) >= epoch(current.lastScrapedAt) ? row : current;
    best.set(key, better);
  }
  return Array.from(best.values());
}

// ---- sorting ----

function sortKey(row, sort) {
  switch (sort) {
    case "demand":
      return getDemandValue(row);
    case "reviews":
      return toNumber(row.reviewCount);
    case "favorites":
      return toNumber(row.favorites);
    case "price":
      return row.priceNumeric == null ? null : row.priceNumeric;
    case "first_review":
      return reviewDateSortKey(row.firstReview);
    case "newest":
    default:
      return epoch(row.lastScrapedAt) || null;
  }
}

export function sortListings(rows, sort = "newest", dir = "desc") {
  const key = SORT_SET.has(sort) ? sort : "newest";
  const factor = dir === "asc" ? 1 : -1;
  const isNull = (v) => v == null || (typeof v === "number" && Number.isNaN(v));
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const ka = sortKey(a, key);
    const kb = sortKey(b, key);
    const na = isNull(ka);
    const nb = isNull(kb);
    if (na && nb) return epoch(b.lastScrapedAt) - epoch(a.lastScrapedAt);
    if (na) return 1; // nulls always last
    if (nb) return -1;
    if (ka !== kb) return ka < kb ? -1 * factor : 1 * factor;
    return epoch(b.lastScrapedAt) - epoch(a.lastScrapedAt); // tiebreak: newest first
  });
}

// ---- filtering ----

function rowMatchesChip(row, chip) {
  if (!chip || chip === "all") return true;
  const history = Array.isArray(row.demandHistory) ? row.demandHistory : [];
  if (history.some((entry) => demandInfoMatchesFilter(entry.info, chip))) return true;
  return demandInfoMatchesFilter(`${row.info || ""} ${row.demandType || ""}`, chip);
}

function splitTerms(value) {
  return String(value || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

export function filterShop(rows, { search = "", demand = "", chip = "all" } = {}) {
  const searchTerms = splitTerms(search);
  const demandTerms = splitTerms(demand);
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!rowMatchesChip(row, chip)) return false;
    if (searchTerms.length) {
      const haystack = `${row.title} ${row.info} ${row.shopName} ${row.url}`.toLowerCase();
      if (!searchTerms.some((t) => haystack.includes(t))) return false;
    }
    if (demandTerms.length) {
      const allInfo = `${row.info || ""} ${row.demandType || ""}`.toLowerCase();
      if (!demandTerms.some((t) => allInfo.includes(t))) return false;
    }
    return true;
  });
}

// ---- pagination ----

export function paginate(rows, page = 1, pageSize = SHOP_PAGE_SIZE) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const start = (current - 1) * pageSize;
  return {
    pageRows: list.slice(start, start + pageSize),
    total,
    totalPages,
    page: current,
    rangeStart: total === 0 ? 0 : start + 1,
    rangeEnd: Math.min(start + pageSize, total),
  };
}

// Expensive prep — normalize + dedupe ALL rows. Do this once (on load/import),
// not on every keystroke/sort/page change.
export function prepareShopRows(rows) {
  return dedupeForShop((Array.isArray(rows) ? rows : []).map(normalizeForShop));
}

// Cheap per-interaction tail over already-prepared rows: filter -> sort -> paginate.
export function queryPrepared(prepared, { search = "", demand = "", chip = "all", sort = "newest", dir = "desc", page = 1, pageSize = SHOP_PAGE_SIZE } = {}) {
  const base = Array.isArray(prepared) ? prepared : [];
  const filtered = filterShop(base, { search, demand, chip });
  const sorted = sortListings(filtered, sort, dir);
  return { ...paginate(sorted, page, pageSize), grandTotal: base.length };
}

// Full hosted-shop query pipeline: dedupe -> filter -> sort -> paginate.
export function queryShop(rows, opts = {}) {
  return queryPrepared(prepareShopRows(rows), opts);
}

export function shopStats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    total: list.length,
    withDemand: list.filter((row) => getDemandValue(row) > 0 || row.info).length,
    digital: list.filter((row) => row.isDigital === true).length,
  };
}
