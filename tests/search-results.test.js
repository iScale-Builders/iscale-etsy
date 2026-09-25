import { describe, it, expect } from "vitest";
import { detectSearchBlock, parseSearchResults, parseTotalResults, parseTotalResultsDetail, mergeSearchResult, searchResultKey, globalRank, MAX_APPEARANCES } from "../src/core/search-results.js";

function setBody(html) {
  document.body.innerHTML = html;
  return document;
}

describe("parseSearchResults", () => {
  it("captures keyword, page, position, and per-card info in order", () => {
    const doc = setBody(`
      <ul>
        <li data-listing-id="1111111111">
          <a href="/listing/1111111111/cat-mug">Cat Mug</a>
          <h3>Cat Mug Funny Gift</h3>
          <span class="currency-symbol">$</span><span class="currency-value">12.99</span>
          <span aria-label="4.5 out of 5 stars"></span>
          <span>(1,234)</span>
          <img src="cat.jpg" />
        </li>
        <li data-listing-id="2222222222">
          <a href="/listing/2222222222/dog-shirt">Dog Shirt</a>
          <h3>Dog Dad Shirt</h3>
          <span class="currency-symbol">$</span><span class="currency-value">24.00</span>
          <span>Ad by Etsy seller</span>
          <img src="dog.jpg" />
        </li>
      </ul>
    `);
    const out = parseSearchResults(doc, "https://www.etsy.com/search?q=cat%20mug&page=2");
    expect(out.keyword).toBe("cat mug");
    expect(out.page).toBe(2);
    expect(out.results).toHaveLength(2);

    const [a, b] = out.results;
    expect(a).toMatchObject({
      position: 1,
      listingId: "1111111111",
      url: "https://www.etsy.com/listing/1111111111",
      title: "Cat Mug Funny Gift",
      price: "$12.99",
      reviewCount: 1234,
      rating: 4.5,
      isAd: false,
    });
    expect(b).toMatchObject({ position: 2, listingId: "2222222222", price: "$24.00", isAd: true });
  });

  it("de-dupes repeated anchors to the same listing", () => {
    const doc = setBody(`
      <a href="/listing/3333333333/x">first</a>
      <a href="/listing/3333333333/x">dup</a>
      <a href="/listing/4444444444/y">second</a>
    `);
    const out = parseSearchResults(doc, "https://www.etsy.com/search?q=mug");
    expect(out.results.map((r) => r.listingId)).toEqual(["3333333333", "4444444444"]);
    expect(out.results[1].position).toBe(2);
  });

  it("captures the search total, currency, badges, favorites, tags, and sales signals", () => {
    const doc = setBody(`
      <h1><span>1,248 results, with ads</span></h1>
      <li data-listing-id="5555555555">
        <a href="/listing/5555555555/apron">Apron</a>
        <h3>Linen apron</h3>
        <span class="currency-symbol">£</span><span class="currency-value">18.00</span>
        <span>Bestseller</span>
        <span>Popular now</span>
        <span>1,024 favorites</span>
        <span class="wt-tag" data-tag>linen</span>
        <span>In 12 carts</span>
        <img src="apron.jpg" />
      </li>
    `);
    const out = parseSearchResults(doc, "https://www.etsy.com/search?q=linen%20apron");
    expect(out.totalResults).toBe(1248);
    expect(out.totalResultsRaw).toBe("1,248 results");
    expect(parseTotalResults(doc)).toBe(1248);
    expect(out.results[0]).toMatchObject({
      price: "£18.00",
      priceNumeric: 18,
      currency: "GBP",
      favorites: 1024,
      isBestseller: true,
      isPopular: true,
      salesSignal: "In 12 carts",
      tags: ["linen"],
    });
  });
});

describe("parseTotalResultsDetail", () => {
  it("keeps the number and the raw string for Etsy count formats", () => {
    expect(parseTotalResultsDetail(setBody("<h1>1,000+ results</h1>"))).toEqual({ count: 1000, raw: "1,000+ results" });
    expect(parseTotalResultsDetail(setBody("<span>12,345 results</span>"))).toEqual({ count: 12345, raw: "12,345 results" });
    expect(parseTotalResultsDetail(setBody("<p>Over 50,000 results</p>"))).toEqual({ count: 50000, raw: "Over 50,000 results" });
  });
});

describe("detectSearchBlock", () => {
  it("does not treat a normal results page as a block", () => {
    const doc = setBody(`<a href="/listing/5555555555/apron">Apron</a><p>1,248 results</p>`);
    expect(detectSearchBlock(doc)).toEqual({ blocked: false, reason: null, noResults: false });
  });

  it("does not treat an empty search as a captcha", () => {
    const doc = setBody(`<h1>0 results for linen apron</h1><p>We couldn't find any results.</p>`);
    expect(detectSearchBlock(doc)).toMatchObject({ blocked: false, noResults: true });
  });

  it("stops on a captcha interstitial", () => {
    const doc = setBody(`<title>Just a moment</title><h1>Verify you are a human</h1><iframe src="https://geo.captcha-delivery.com/captcha/"></iframe>`);
    document.title = "Just a moment";
    expect(detectSearchBlock(doc)).toEqual({ blocked: true, reason: "captcha", noResults: false });
  });

  it("treats zero listings without an empty-state marker as suspicious on a search page only", () => {
    const doc = setBody(`<h1>Search</h1><p>Please wait</p>`);
    expect(detectSearchBlock(doc, "https://www.etsy.com/search?q=linen")).toEqual({
      blocked: true,
      reason: "suspicious_empty",
      noResults: false,
    });
    expect(detectSearchBlock(doc, "https://www.etsy.com/shop/CoolShop")).toEqual({
      blocked: false,
      reason: null,
      noResults: false,
    });
    expect(detectSearchBlock(doc, "https://www.etsy.com/listing/1234567890/linen-apron")).toEqual({
      blocked: false,
      reason: null,
      noResults: false,
    });
  });
});

describe("globalRank", () => {
  it("ranks across pages", () => {
    expect(globalRank(1, 1)).toBe(1);
    expect(globalRank(2, 1)).toBe(65);
    expect(globalRank(3, 5)).toBe(133);
  });
});

describe("mergeSearchResult", () => {
  const incoming = (over = {}) => ({
    keyword: "cat mug",
    listingId: "1111111111",
    url: "https://www.etsy.com/listing/1111111111/cat-mug",
    title: "Cat Mug",
    price: "$12.99",
    reviewCount: 1234,
    rating: 4.5,
    page: 1,
    position: 3,
    isAd: false,
    capturedAt: "2026-06-17T12:00:00Z",
    ...over,
  });

  it("creates a row keyed by keyword+listing with one appearance", () => {
    const row = mergeSearchResult(null, incoming(), "2026-06-17T12:00:00Z");
    expect(row.id).toBe(searchResultKey("cat mug", "1111111111"));
    expect(row.appearances).toHaveLength(1);
    expect(row.appearances[0]).toMatchObject({ page: 1, position: 3, rank: 3, capturedAt: "2026-06-17T12:00:00Z" });
    expect(row.bestRank).toBe(3);
    expect(row.firstSeenAt).toBe("2026-06-17T12:00:00Z");
  });

  it("keeps the first-seen keyword casing across re-captures", () => {
    const first = mergeSearchResult(null, incoming({ keyword: "Cat Mug" }), "2026-06-17T12:00:00Z");
    const second = mergeSearchResult(first, incoming({ keyword: "cat mug" }), "2026-06-18T12:00:00Z");
    expect(second.keyword).toBe("Cat Mug");
    expect(second.id).toBe(first.id); // case-insensitive key
  });

  it("accumulates appearances over time and tracks best rank + latest position", () => {
    const first = mergeSearchResult(null, incoming({ page: 2, position: 5 }), "2026-06-17T12:00:00Z");
    const second = mergeSearchResult(first, incoming({ page: 1, position: 2, capturedAt: "2026-06-18T12:00:00Z" }), "2026-06-18T12:00:00Z");
    expect(second.appearances).toHaveLength(2);
    expect(second.latestPage).toBe(1);
    expect(second.latestPosition).toBe(2);
    expect(second.bestRank).toBe(2); // page1 pos2 beats page2 pos5 (rank 69)
    expect(second.firstSeenAt).toBe("2026-06-17T12:00:00Z");
    expect(second.lastSeenAt).toBe("2026-06-18T12:00:00Z");
  });

  it("caps appearances at MAX_APPEARANCES (newest kept) and preserves bestRank past eviction", () => {
    // First capture is the best rank ever (page 1, pos 1 → rank 1), then 40 worse ones.
    let row = mergeSearchResult(null, incoming({ page: 1, position: 1 }), "2026-06-17T00:00:00Z");
    for (let i = 0; i < 40; i++) {
      row = mergeSearchResult(row, incoming({ page: 5, position: 10, capturedAt: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00Z` }), "x");
    }
    expect(row.appearances.length).toBe(MAX_APPEARANCES); // bounded
    // The rank-1 appearance was evicted, but bestRank still reflects it.
    expect(row.bestRank).toBe(1);
    // Newest entries are the ones kept.
    expect(row.appearances[row.appearances.length - 1].capturedAt).toBe("2026-07-40T00:00:00Z");
  });
});
