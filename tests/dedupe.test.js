import { describe, expect, it } from "vitest";
import { dedupeListings, recordScrape, sameCalendarDay } from "../src/core/dedupe.js";

describe("dedupe", () => {
  it("merges duplicate listings by normalized URL", () => {
    const rows = dedupeListings([
      {
        url: "https://www.etsy.com/listing/1234567890/cat-mug?click=1",
        title: "Cat Mug",
        source: "manual",
        searchTerm: "cat mug",
        firstSeenAt: "2026-06-15T10:00:00.000Z",
      },
      {
        url: "https://www.etsy.com/listing/1234567890/cat-mug",
        price: "$12.99",
        source: "batch",
        searchTerm: "gift mug",
        scrapedAt: "2026-06-15T11:00:00.000Z",
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Cat Mug");
    expect(rows[0].price).toBe("$12.99");
    expect(rows[0].sources).toEqual(["manual", "batch"]);
    expect(rows[0].searchTerms).toEqual(["cat mug", "gift mug"]);
  });

  it("seeds the accumulation arrays for a first-seen listing", () => {
    const row = recordScrape(null, {
      id: "listing_1",
      url: "https://www.etsy.com/listing/1/x",
      source: "manual",
      searchTerm: "trending tshirt",
    });
    expect(row.searchTerms).toEqual(["trending tshirt"]);
    expect(row.sources).toEqual(["manual"]);
  });

  it("a later termless visit never blanks an existing search term", () => {
    const existing = recordScrape(null, {
      id: "listing_1",
      url: "https://www.etsy.com/listing/1/x",
      source: "batch",
      searchTerm: "trending tshirt",
      scrapedAt: "2026-06-15T10:00:00.000Z",
    });
    // A direct listing-page visit carries no search term and is newer.
    const merged = recordScrape(existing, {
      id: "listing_1",
      url: "https://www.etsy.com/listing/1/x",
      source: "manual",
      searchTerm: "",
      scrapedAt: "2026-06-16T10:00:00.000Z",
    });
    expect(merged.searchTerm).toBe("trending tshirt");
    expect(merged.searchTerms).toEqual(["trending tshirt"]);
    expect(merged.sources).toEqual(["batch", "manual"]);
  });

  it("unions the searchTerms history arrays (CSV re-import round-trip)", () => {
    const rows = dedupeListings([
      { url: "https://www.etsy.com/listing/1234567890/x", searchTerm: "a", searchTerms: ["a", "b"], scrapedAt: "2026-06-15T10:00:00.000Z" },
      { url: "https://www.etsy.com/listing/1234567890/x", searchTerm: "c", searchTerms: ["c"], scrapedAt: "2026-06-15T11:00:00.000Z" },
    ]);
    expect(rows[0].searchTerms).toEqual(["a", "b", "c"]);
  });
});

describe("sameCalendarDay", () => {
  it("is true within the same local day, false across days or for blanks", () => {
    const now = Date.now();
    expect(sameCalendarDay(new Date(now).toISOString(), now)).toBe(true); // same instant
    expect(sameCalendarDay(new Date(now - 25 * 60 * 60 * 1000).toISOString(), now)).toBe(false); // 25h earlier = prior day
    expect(sameCalendarDay("", now)).toBe(false);
    expect(sameCalendarDay(undefined, now)).toBe(false);
    expect(sameCalendarDay("not-a-date", now)).toBe(false);
  });
});

