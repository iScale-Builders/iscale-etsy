import { findDemandText, hasGoodDemandIndicator, isOnlyLowStock, parseDemandValue } from "./demand.js";
import { extractListingId, normalizeEtsyListingUrl } from "./etsy-url.js";

const DEMAND_SELECTORS = [
  "p.wt-text-title-small.wt-sem-text-critical",
  "p.wt-text-title-01.wt-sem-text-critical",
  "[data-buy-box-region='scarcity'] p",
  "[data-appears-component-name='scarcity_signal'] p",
];

const UNAVAILABLE_INDICATORS = [
  "This item is unavailable",
  "Sorry, this item is unavailable",
  "Sorry, this item is no longer available",
  "This listing has been removed",
  "This item has sold",
  "This item is temporarily unavailable",
];

export function verifyPageMatchesListing(doc, listingId) {
  if (!doc || !listingId) return false;

  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href") || "";
  const ogUrl = doc.querySelector('meta[property="og:url"]')?.getAttribute("content") || "";
  const favoriteId = doc.querySelector("[data-favorite-listing-id]")?.getAttribute("data-favorite-listing-id") || "";
  const dataListing = doc.querySelector(`[data-listing-id="${listingId}"]`);

  const urlSignals = [canonical, ogUrl].filter((value) => value.includes(`/listing/${listingId}`)).length;
  return urlSignals >= 1 || favoriteId === listingId || !!dataListing;
}

export function verifyTitleMatch(doc, title) {
  if (!doc || !title) return true;
  const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim().toLowerCase();
  if (!ogTitle) return true;
  const normalized = title.trim().toLowerCase();
  return ogTitle.includes(normalized.slice(0, 30)) || normalized.includes(ogTitle.slice(0, 30));
}

export function detectDigitalVsPhysical(doc) {
  const signals = {
    jsonld_offer_type: null,
    jsonld_has_shipping_origin: null,
    has_digital_delivery_div: !!doc.getElementById("digital_delivery"),
    has_digital_delivery_component: !!doc.querySelector('[data-appears-component-name="digital_delivery"]'),
    has_shipping_and_returns_div: !!doc.getElementById("shipping_and_returns"),
    has_shipping_and_returns_component: !!doc.querySelector('[data-appears-component-name="shipping_and_returns"]'),
    verdict: null,
    confidence: "low",
  };

  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent);
      if (data?.["@type"] === "Product" && data.offers) {
        signals.jsonld_offer_type = data.offers["@type"] || null;
        signals.jsonld_has_shipping_origin = !!(data.offers.shippingDetails && data.offers.shippingDetails.shippingOrigin);
        break;
      }
    } catch {
      // Ignore invalid structured data.
    }
  }

  const digitalVotes =
    (signals.jsonld_offer_type === "Offer" && signals.jsonld_has_shipping_origin === false ? 1 : 0) +
    (signals.has_digital_delivery_div ? 1 : 0) +
    (signals.has_digital_delivery_component ? 1 : 0);
  const physicalVotes =
    (signals.jsonld_offer_type === "AggregateOffer" || signals.jsonld_has_shipping_origin === true ? 1 : 0) +
    (signals.has_shipping_and_returns_div ? 1 : 0) +
    (signals.has_shipping_and_returns_component ? 1 : 0);

  if (digitalVotes >= 2 && physicalVotes === 0) {
    signals.verdict = true;
    signals.confidence = digitalVotes === 3 ? "high" : "medium";
  } else if (physicalVotes >= 2 && digitalVotes === 0) {
    signals.verdict = false;
    signals.confidence = physicalVotes === 3 ? "high" : "medium";
  } else if (digitalVotes >= 2 && physicalVotes >= 2) {
    signals.confidence = "conflict";
  }

  return { isDigital: signals.verdict, signals };
}

export function extractListingFromDocument(doc = document, href = window.location.href, options = {}) {
  const startedUrl = String(href || "");
  const normalizedUrl = normalizeEtsyListingUrl(startedUrl);
  const listingId = extractListingId(normalizedUrl || startedUrl);
  if (!listingId) return { found: false, reason: "no_listing_id" };

  const pageText = doc.body?.innerText || doc.body?.textContent || "";
  if (UNAVAILABLE_INDICATORS.some((indicator) => pageText.includes(indicator))) {
    return { found: false, reason: "product_unavailable", listingId, normalizedUrl };
  }

  if (options.requirePageMatch !== false && !verifyPageMatchesListing(doc, listingId)) {
    return { found: false, reason: "page_content_mismatch", listingId, normalizedUrl };
  }

  const title =
    doc.querySelector('h1[data-buy-box-listing-title="true"]')?.textContent?.trim() ||
    doc.querySelector("h1")?.textContent?.trim() ||
    "";
  if (!title) return { found: false, reason: "missing_title", listingId, normalizedUrl };
  if (!verifyTitleMatch(doc, title)) return { found: false, reason: "title_mismatch", listingId, normalizedUrl };

  const price =
    doc.querySelector('[data-buy-box-region="price"] p')?.textContent?.trim() ||
    doc.querySelector('meta[property="product:price:amount"]')?.content ||
    doc.querySelector('meta[property="og:price:amount"]')?.content ||
    "";

  const demandText = findDemandText(
    [
      ...DEMAND_SELECTORS.map((selector) => doc.querySelector(selector)?.textContent || ""),
      doc.querySelector(".cart-col")?.textContent || "",
      doc.querySelector("[data-buy-box-region]")?.textContent || "",
      pageText,
    ].join("\n"),
  );
  const goodDemand = !!demandText && hasGoodDemandIndicator(demandText) && !isOnlyLowStock(demandText);
  const demand = parseDemandValue(demandText);
  const digital = detectDigitalVsPhysical(doc);
  const reviews = extractStaticReviewDates(doc);
  const now = new Date().toISOString();

  return {
    found: true,
    id: `listing_${listingId}`,
    url: normalizedUrl || startedUrl.split("?")[0],
    normalizedUrl: normalizedUrl || startedUrl.split("?")[0],
    listingId,
    title,
    price,
    priceNumeric: parsePrice(price),
    currency: parseCurrency(price),
    shopName: doc.querySelector('[data-buy-box-region="shop-name-block"] a')?.textContent?.trim() || "",
    imageUrl: doc.querySelector('meta[property="og:image"]')?.content || "",
    demandText,
    demandType: demand.demandType,
    demandValue: demand.demandValue,
    hasDemandIndicator: goodDemand,
    favorites: extractFavorites(doc),
    reviewCount: extractReviewCount(doc),
    firstReview: reviews.firstReview,
    lastReview: reviews.lastReview,
    isDigital: digital.isDigital,
    digitalSignals: digital.signals,
    source: options.source || "manual",
    searchTerm: options.searchTerm || "",
    deleted: false,
    firstSeenAt: now,
    lastSeenAt: now,
    scrapedAt: now,
  };
}

// Favorites count selectors.
export function extractFavorites(doc) {
  const selectors = ["[data-favorite-listing-id]", 'button[aria-label*="favorite"]', ".wt-text-caption", ".wt-text-body-01"];
  for (const selector of selectors) {
    for (const el of doc.querySelectorAll(selector)) {
      const text = el.textContent || el.getAttribute?.("aria-label") || "";
      const match = text.match(/(\d[\d,]*)\s*(?:favorites?|people have this)/i);
      if (match) return Number.parseInt(match[1].replace(/,/g, ""), 10);
    }
  }
  return 0;
}

// Review count — ONLY trust data-appears-event-data.listing_rating_count.
// (Etsy leaks the shop's rating count into JSON-LD when a listing has 0 reviews.)
export function extractReviewCount(doc) {
  for (const el of doc.querySelectorAll("[data-appears-event-data]")) {
    try {
      const data = JSON.parse(el.getAttribute("data-appears-event-data"));
      if (data && data.listing_rating_count != null) {
        const n = Number.parseInt(data.listing_rating_count, 10);
        if (!Number.isNaN(n)) return n;
      }
    } catch {
      // Malformed JSON — try the next element.
    }
  }
  return 0;
}

// Authoritative "this ITEM has zero reviews" signal. True when Etsy explicitly reports a
// listing_rating_count of 0, OR the page shows its empty-state copy ("Be the first to
// review this item"). Used to HARD-STOP review extraction BEFORE any modal opens: a
// no-review item has no item-reviews modal, so forcing one open scrapes the SHOP's
// reviews by mistake (a real-world bug where a half-loaded page fell through to the shop
// modal). `listingRatingCount` is null/undefined when UNKNOWN (e.g. the data attribute
// hasn't loaded yet) — unknown is deliberately NOT treated as zero, so we never declare
// "no reviews" off a page that simply hasn't rendered.
export function noItemReviews({ listingRatingCount = null, bodyText = "" } = {}) {
  if (listingRatingCount === 0) return true;
  if (/be the first to review this item/i.test(bodyText || "")) return true;
  return false;
}

// Month name → index, accepting both 3-letter abbreviations AND full English names
// (plus the "Sept" variant). Lowercased keys. (audit M-10)
const MONTH_INDEX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

function inEtsyDateRange(d) {
  if (!d || Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 2005 || y > new Date().getUTCFullYear() + 1) return null; // Etsy launched 2005
  return d;
}

// Parse a review date robustly and locale-tolerantly. Accepts ISO (yyyy-mm-dd — e.g. a
// <time datetime> attribute), "Mon[th] D[,] YYYY", and "D Mon[th][,] YYYY", with 3-letter
// OR full month names and an optional comma. Built on UTC so toISOString().slice(0,10)
// never shifts the day by the runner's timezone (the old local-time parse could). Rejects
// rollover (Feb 30 -> Mar 1) and out-of-Etsy-range years. Returns a UTC Date or null.
// (audit M-10) NOTE: UTC is intentional; dedupe.js sameCalendarDay intentionally
// uses LOCAL time instead (operator-facing "today"). See the note there.
export function parseValidReviewDate(str) {
  const s = String(str || "").trim();
  if (!s) return null;
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})/); // tolerate a trailing T-time (e.g. <time datetime>)
  if (iso) {
    const y = +iso[1];
    const m = +iso[2];
    const day = +iso[3];
    const d = new Date(Date.UTC(y, m - 1, day));
    if (d.getUTCMonth() !== m - 1 || d.getUTCDate() !== day) return null;
    return inEtsyDateRange(d);
  }
  let mon;
  let day;
  let year;
  let m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/); // Month D[,] YYYY
  if (m) {
    mon = MONTH_INDEX[m[1].toLowerCase()];
    day = +m[2];
    year = +m[3];
  } else {
    m = s.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/); // D Month[,] YYYY
    if (m) {
      mon = MONTH_INDEX[m[2].toLowerCase()];
      day = +m[1];
      year = +m[3];
    }
  }
  if (mon === undefined || !day || !year) return null;
  const d = new Date(Date.UTC(year, mon, day));
  if (d.getUTCMonth() !== mon || d.getUTCDate() !== day) return null; // rollover guard
  return inEtsyDateRange(d);
}

// Static (no-modal) first/last review dates from the reviews region. PREFERS machine-
// readable <time datetime> attributes (locale-proof), then falls back to text dates in
// abbreviated/full-month, comma-optional, or ISO form. (audit M-10)
export function extractStaticReviewDates(doc) {
  const body = doc.body?.innerText || doc.body?.textContent || "";
  if (/be the first to review this item/i.test(body)) {
    return { firstReview: "None", lastReview: "None" };
  }
  const region =
    doc.getElementById?.("reviews") ||
    doc.querySelector('[data-appears-component-name="listing_page_reviews"]') ||
    doc.querySelector('[id*="review"]');
  if (!region) return { firstReview: "", lastReview: "" };

  const dates = [];
  for (const t of region.querySelectorAll?.("time[datetime]") || []) {
    const d = parseValidReviewDate(t.getAttribute("datetime"));
    if (d) dates.push(d);
  }
  if (dates.length === 0) {
    const text = region.innerText || region.textContent || "";
    const matches =
      text.match(/[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}|\d{4}-\d{2}-\d{2}/g) || [];
    for (const token of matches) {
      const d = parseValidReviewDate(token);
      if (d) dates.push(d);
    }
  }
  if (dates.length === 0) return { firstReview: "", lastReview: "" };
  dates.sort((a, b) => a - b);
  return {
    firstReview: dates[0].toISOString().slice(0, 10),
    lastReview: dates[dates.length - 1].toISOString().slice(0, 10),
  };
}

function parsePrice(value) {
  const match = String(value || "").match(/[\d,.]+/);
  if (!match) return null;
  const raw = match[0];
  if (/^\d+,\d{2}$/.test(raw)) return Number.parseFloat(raw.replace(",", "."));
  return Number.parseFloat(raw.replace(/,/g, ""));
}

function parseCurrency(value) {
  const text = String(value || "");
  if (text.includes("€")) return "EUR";
  if (text.includes("£")) return "GBP";
  if (text.includes("$")) return "USD";
  return "";
}

