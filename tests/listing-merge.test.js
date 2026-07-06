import { describe, it, expect } from "vitest";
import { mergeListing, recordScrape } from "../src/core/dedupe.js";

const base = (over = {}) => ({
  url: "https://www.etsy.com/listing/1234567890/cat-mug",
  normalizedUrl: "https://www.etsy.com/listing/1234567890/cat-mug",
  listingId: "1234567890",
  title: "Cat Mug",
  demandText: "In 10 carts",
  demandType: "in_carts",
  demandValue: 10,
  ...over,
});

describe("recordScrape (live scrape accumulation)", () => {
  it("seeds a demand_history entry for a brand-new listing", () => {
    const rec = recordScrape(null, base({ scrapedAt: "2026-06-17T12:00:00.000Z" }), "2026-06-17T12:00:00.000Z");
    expect(rec.demandHistory).toHaveLength(1);
    expect(rec.demandHistory[0]).toMatchObject({ value: 10, type: "in_carts", info: "In 10 carts" });
    expect(rec.firstSeenAt).toBe("2026-06-17T12:00:00.000Z");
  });

  it("appends a new demand entry on a later scrape (>1h apart)", () => {
    const first = recordScrape(null, base({ demandValue: 10, demandText: "In 10 carts" }), "2026-06-17T12:00:00.000Z");
    const second = recordScrape(first, base({ demandValue: 25, demandText: "In 25 carts" }), "2026-06-17T15:00:00.000Z");
    expect(second.demandHistory).toHaveLength(2);
    expect(second.demandHistory[0].value).toBe(25);
    expect(second.demandHistory[1].value).toBe(10);
    expect(second.firstSeenAt).toBe("2026-06-17T12:00:00.000Z");
    expect(second.lastScrapedAt).toBe("2026-06-17T15:00:00.000Z");
  });
});

describe("mergeListing (import/union of snapshots)", () => {
  it("unions demand histories without appending a synthetic entry", () => {
    const existing = base({
      demandHistory: [{ created_at: "2026-06-16T00:00:00Z", timestamp: "2026-06-16T00:00:00Z", value: 5, info: "In 5 carts" }],
      lastScrapedAt: "2026-06-16T00:00:00Z",
    });
    const incoming = base({
      demandHistory: [{ created_at: "2026-06-17T00:00:00Z", timestamp: "2026-06-17T00:00:00Z", value: 9, info: "In 9 carts" }],
      lastScrapedAt: "2026-06-17T00:00:00Z",
    });
    const out = mergeListing(existing, incoming);
    expect(out.demandHistory).toHaveLength(2);
    expect(out.demandHistory[0].value).toBe(9);
  });

  it("preserves deleted state when the incoming snapshot omits it", () => {
    const existing = base({ deleted: true, deletedAt: "2026-06-10T00:00:00Z", lastScrapedAt: "2026-06-10T00:00:00Z" });
    const incoming = base({ lastScrapedAt: "2026-06-15T00:00:00Z" });
    const out = mergeListing(existing, incoming);
    expect(out.deleted).toBe(true);
    expect(out.deletedAt).toBe("2026-06-10T00:00:00Z");
  });

  it("resurrects when a newer snapshot explicitly says not deleted", () => {
    const existing = base({ deleted: true, lastScrapedAt: "2026-06-10T00:00:00Z" });
    const incoming = base({ deleted: false, lastScrapedAt: "2026-06-15T00:00:00Z" });
    expect(mergeListing(existing, incoming).deleted).toBe(false);
  });

  it("never clobbers a real first_review with a blank", () => {
    const existing = base({ firstReview: "2024-01-02", lastScrapedAt: "2026-06-10T00:00:00Z" });
    const incoming = base({ firstReview: "", lastScrapedAt: "2026-06-15T00:00:00Z" });
    expect(mergeListing(existing, incoming).firstReview).toBe("2024-01-02");
  });

  it("never clobbers a real last_review with a blank/None", () => {
    const existing = base({ lastReview: "2024-01-02", lastScrapedAt: "2026-06-10T00:00:00Z" });
    const incoming = base({ lastReview: "None", lastScrapedAt: "2026-06-15T00:00:00Z" });
    expect(mergeListing(existing, incoming).lastReview).toBe("2024-01-02");
  });

  it("takes a newer real last_review over the old one", () => {
    const existing = base({ lastReview: "2024-01-02", lastScrapedAt: "2026-06-10T00:00:00Z" });
    const incoming = base({ lastReview: "2025-03-04", lastScrapedAt: "2026-06-15T00:00:00Z" });
    expect(mergeListing(existing, incoming).lastReview).toBe("2025-03-04");
  });

  it("takes favorites/reviewCount from the newer snapshot", () => {
    const existing = base({ favorites: 10, reviewCount: 3, lastScrapedAt: "2026-06-10T00:00:00Z" });
    const incoming = base({ favorites: 55, reviewCount: 8, lastScrapedAt: "2026-06-15T00:00:00Z" });
    const out = mergeListing(existing, incoming);
    expect(out.favorites).toBe(55);
    expect(out.reviewCount).toBe(8);
  });

  it("does NOT let a blank/zero re-scrape clobber real favorites/demand/reviews", () => {
    const existing = recordScrape(null, base({ favorites: 120, reviewCount: 40, demandValue: 18, demandText: "In 18 carts" }), "2026-06-17T12:00:00.000Z");
    // Etsy failed to render the blocks on the next scrape -> extractors return 0.
    const out = recordScrape(existing, base({ favorites: 0, reviewCount: 0, demandValue: 0, demandText: "" }), "2026-06-17T15:00:00.000Z");
    expect(out.favorites).toBe(120);
    expect(out.reviewCount).toBe(40);
    expect(out.demandValue).toBe(18);
  });

  it("prefers existing on a timestamp tie (blank incoming can't win)", () => {
    const existing = base({ favorites: 99, lastScrapedAt: "2026-06-15T00:00:00Z" });
    const incoming = base({ favorites: 0, lastScrapedAt: "2026-06-15T00:00:00Z" });
    expect(mergeListing(existing, incoming).favorites).toBe(99);
  });

  it("clears deletedAt when a listing is resurrected", () => {
    const existing = base({ deleted: true, deletedAt: "2026-06-10T00:00:00Z", lastScrapedAt: "2026-06-10T00:00:00Z" });
    const incoming = base({ deleted: false, lastScrapedAt: "2026-06-15T00:00:00Z" });
    const out = mergeListing(existing, incoming);
    expect(out.deleted).toBe(false);
    expect(out.deletedAt).toBe("");
  });

  it("strips stale snake_case aliases after merging", () => {
    const existing = base({ lastScrapedAt: "2026-06-10T00:00:00Z" });
    const incoming = base({ demand_history: [{ value: 9 }], review_count: 5, is_digital: true, lastScrapedAt: "2026-06-15T00:00:00Z" });
    const out = mergeListing(existing, incoming);
    expect(out.demand_history).toBeUndefined();
    expect(out.review_count).toBeUndefined();
    expect(out.is_digital).toBeUndefined();
  });

  it("keeps the earliest firstSeenAt across an import union", () => {
    const existing = base({ firstSeenAt: "2026-06-12T00:00:00Z", lastScrapedAt: "2026-06-12T00:00:00Z" });
    const incoming = base({ firstSeenAt: "2026-06-05T00:00:00Z", lastScrapedAt: "2026-06-15T00:00:00Z" });
    expect(mergeListing(existing, incoming).firstSeenAt).toBe("2026-06-05T00:00:00Z");
  });
});
