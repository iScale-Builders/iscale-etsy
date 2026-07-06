// Capture FULL data about every Etsy search result: which keyword was searched,
// which page, what position the listing held, plus title/price/reviews/rating/
// shop/image and whether it was an ad — accumulated over time with timestamps so
// you keep the complete history of how a listing ranked for a keyword.
//
// parseSearchResults() is pure (jsdom-testable). The same DOM walk is mirrored
// inline in content.js (content scripts can't import ES modules) — keep in sync.

const ETSY_PAGE_SIZE = 64; // approx results per Etsy search page, for a global rank

// Max appearance-history entries kept per search-result row (newest wins), mirroring
// MAX_DEMAND_HISTORY. Prevents a single row growing without bound under daily auto-run.
export const MAX_APPEARANCES = 30;

export function searchResultKey(keyword, listingId) {
  return `search::${String(keyword || "").trim().toLowerCase()}::${listingId}`;
}

export function globalRank(page, position) {
  const p = Math.max(1, Number(page) || 1);
  const pos = Math.max(1, Number(position) || 1);
  return (p - 1) * ETSY_PAGE_SIZE + pos;
}

function num(value) {
  if (value == null || value === "") return null;
  const match = String(value).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : null;
}

function safeUrl(href) {
  try {
    return new URL(href, "https://www.etsy.com");
  } catch {
    return null;
  }
}

function closestCard(anchor) {
  let el = anchor;
  for (let i = 0; i < 6 && el && el.parentElement; i++) {
    el = el.parentElement;
    if (!el.getAttribute) continue;
    if (el.getAttribute("data-listing-id") || /(^|\s)(v2-listing-card|listing-link|wt-grid__item|js-merch-stash-check-listing)/.test(el.className || "")) {
      return el;
    }
    if (el.tagName === "LI") return el;
  }
  return anchor.parentElement || anchor;
}

function cardText(card, selector) {
  const el = card?.querySelector?.(selector);
  return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
}

function cardPrice(card) {
  if (!card?.querySelector) return "";
  const value = card.querySelector(".currency-value");
  if (value) {
    const symbol = card.querySelector(".currency-symbol");
    return `${symbol ? symbol.textContent.trim() : ""}${value.textContent.trim()}`;
  }
  const text = card.textContent || "";
  const match = text.match(/[$£€]\s?\d[\d,.]*/);
  return match ? match[0].replace(/\s/g, "") : "";
}

function cardRating(card) {
  if (!card?.querySelector) return null;
  for (const el of card.querySelectorAll('[aria-label*="out of 5"], input[name*="rating"]')) {
    const m = String(el.getAttribute("aria-label") || el.getAttribute("value") || "").match(/([\d.]+)\s*out of 5/i) || String(el.getAttribute("value") || "").match(/^([\d.]+)$/);
    if (m) return Number.parseFloat(m[1]);
  }
  return null;
}

function cardReviewCount(card) {
  if (!card?.querySelector) return null;
  const labelled = card.querySelector('[aria-label*="review" i]');
  if (labelled) {
    const n = num(labelled.getAttribute("aria-label"));
    if (n != null) return n;
  }
  const m = (card.textContent || "").match(/\(([\d,]+)\)/);
  return m ? num(m[1]) : null;
}

function cardImage(card) {
  const img = card?.querySelector?.("img");
  return img ? img.getAttribute("src") || img.getAttribute("data-src") || "" : "";
}

function cardIsAd(card) {
  const text = (card?.textContent || "").toLowerCase();
  return text.includes("ad by") || text.includes("advertisement") || text.includes("ad from");
}

export function parseSearchResults(doc, href, nowIso) {
  const url = safeUrl(href);
  const keyword = (url?.searchParams.get("q") || "").trim();
  const page = Math.max(1, Number.parseInt(url?.searchParams.get("page") || "1", 10) || 1);
  const capturedAt = nowIso || new Date().toISOString();
  const results = [];
  const seen = new Set();

  for (const anchor of doc.querySelectorAll('a[href*="/listing/"]')) {
    const listingId = (String(anchor.getAttribute("href") || "").match(/\/listing\/(\d{7,12})/) || [])[1];
    if (!listingId || seen.has(listingId)) continue;
    seen.add(listingId);
    const card = closestCard(anchor);
    results.push({
      keyword,
      page,
      position: results.length + 1,
      listingId,
      url: `https://www.etsy.com/listing/${listingId}`,
      title: cardText(card, "h3") || (anchor.getAttribute("title") || anchor.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
      price: cardPrice(card),
      reviewCount: cardReviewCount(card),
      rating: cardRating(card),
      shopName: cardText(card, ".v2-listing-card__shop, [data-shop-name]"),
      imageUrl: cardImage(card),
      isAd: cardIsAd(card),
      capturedAt,
    });
  }
  return { keyword, page, capturedAt, results };
}

// Accumulate a captured result into the stored row, keeping the full appearance
// history (page/position/price/reviews over time) with timestamps.
export function mergeSearchResult(existing, incoming, nowIso) {
  const now = nowIso || incoming.capturedAt || new Date().toISOString();
  const appearance = {
    page: incoming.page,
    position: incoming.position,
    rank: globalRank(incoming.page, incoming.position),
    price: incoming.price || "",
    reviewCount: incoming.reviewCount ?? null,
    rating: incoming.rating ?? null,
    isAd: incoming.isAd === true,
    capturedAt: incoming.capturedAt || now,
  };
  // Cap the appearance history (newest kept) so a daily auto-run re-scanning the same
  // terms can't grow a single row without bound. bestRank is carried forward from the
  // stored value (or recomputed from legacy rows lacking it) so capping never loses the
  // historical best rank even after old appearances are dropped.
  const allAppearances = [...(existing?.appearances || []), appearance];
  const appearances = allAppearances.length > MAX_APPEARANCES ? allAppearances.slice(-MAX_APPEARANCES) : allAppearances;
  const priorBest = Number.isFinite(existing?.bestRank)
    ? existing.bestRank
    : (existing?.appearances || []).reduce((m, a) => Math.min(m, a.rank ?? Infinity), Infinity);
  const bestRank = Math.min(priorBest, appearance.rank);

  return {
    id: searchResultKey(incoming.keyword, incoming.listingId),
    // Keep the first-seen casing stable across re-captures of the same keyword.
    keyword: existing?.keyword || incoming.keyword,
    listingId: incoming.listingId,
    url: incoming.url || existing?.url || "",
    title: incoming.title || existing?.title || "",
    price: incoming.price || existing?.price || "",
    reviewCount: incoming.reviewCount ?? existing?.reviewCount ?? null,
    rating: incoming.rating ?? existing?.rating ?? null,
    shopName: incoming.shopName || existing?.shopName || "",
    imageUrl: incoming.imageUrl || existing?.imageUrl || "",
    isAd: incoming.isAd === true || existing?.isAd === true,
    latestPage: incoming.page,
    latestPosition: incoming.position,
    bestRank: Number.isFinite(bestRank) ? bestRank : globalRank(incoming.page, incoming.position),
    appearances,
    firstSeenAt: existing?.firstSeenAt || appearance.capturedAt,
    lastSeenAt: appearance.capturedAt,
  };
}

export const SEARCH_EXPORT_COLUMNS = [
  "keyword",
  "listingId",
  "url",
  "title",
  "price",
  "reviewCount",
  "rating",
  "shopName",
  "isAd",
  "latestPage",
  "latestPosition",
  "bestRank",
  "firstSeenAt",
  "lastSeenAt",
  "appearances",
];
