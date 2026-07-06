const ETSY_LISTING_RE = /\/listing\/(\d{7,12})(?:\/|$)/;

export function extractListingId(value) {
  if (!value) return null;
  const match = String(value).match(ETSY_LISTING_RE);
  return match ? match[1] : null;
}

export function normalizeEtsyListingUrl(value) {
  if (!value || typeof value !== "string") return null;

  let parsed;
  try {
    parsed = new URL(value, "https://www.etsy.com");
  } catch {
    return null;
  }

  if (!/(^|\.)etsy\.com$/i.test(parsed.hostname)) return null;
  const listingId = extractListingId(parsed.pathname);
  if (!listingId) return null;

  const parts = parsed.pathname.split("/").filter(Boolean);
  const slug = parts[2] ? `/${parts[2]}` : "";
  return `https://www.etsy.com/listing/${listingId}${slug}`;
}

export function buildSearchUrl(term, page = 1, sort = "most_relevant") {
  const normalizedTerm = String(term || "").trim().replace(/\s+/g, " ");
  if (!normalizedTerm) return null;
  const url = new URL("https://www.etsy.com/search");
  url.searchParams.set("q", normalizedTerm);
  url.searchParams.set("page", String(Math.max(1, Number.parseInt(page, 10) || 1)));
  url.searchParams.set("order", sort || "most_relevant");
  return url.toString();
}

export function parseSearchTerms(input) {
  const values = Array.isArray(input) ? input : String(input || "").split(/[\n,]/);
  const seen = new Set();
  const terms = [];

  for (const raw of values) {
    const term = String(raw || "").trim().replace(/\s+/g, " ");
    if (term.length < 2 || term.length > 100) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }

  return terms;
}

