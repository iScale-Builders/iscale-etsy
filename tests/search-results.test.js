import { describe, it, expect } from "vitest";
import { parseSearchResults, mergeSearchResult, searchResultKey, globalRank, MAX_APPEARANCES } from "../src/core/search-results.js";

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
