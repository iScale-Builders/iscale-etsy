import { describe, it, expect } from "vitest";
import {
  normalizeForShop,
  parsePriceNumeric,
  getDemandValue,
  getDemandIndicators,
  demandInfoMatchesFilter,
  parseReviewDate,
  formatReviewDate,
  sortListings,
  filterShop,
  dedupeForShop,
  paginate,
  queryShop,
  toNumber,
} from "../src/core/shop-sort.js";

describe("toNumber / parsePriceNumeric", () => {
  it("parses numbers and strings", () => {
    expect(toNumber("1,234")).toBe(1234);
    expect(toNumber("$19.99")).toBe(19.99);
    expect(toNumber("")).toBe(0);
  });
  it("parses US and EU price strings", () => {
    expect(parsePriceNumeric("$1,299.50")).toBe(1299.5);
    expect(parsePriceNumeric("1.299,50 €")).toBe(1299.5);
    expect(parsePriceNumeric("19,99")).toBe(19.99);
    expect(parsePriceNumeric("none")).toBe(null);
  });
});

describe("normalizeForShop", () => {
  it("maps camelCase and parses demandHistory JSON string", () => {
    const out = normalizeForShop({
      url: "u",
      title: "Sticker",
      price: "$4.00",
      isDigital: true,
      demandText: "In 20 carts",
      demandValue: 20,
      demandHistory: JSON.stringify([{ info: "In 20 carts", timestamp: "2026-06-17T00:00:00Z" }]),
      scrapedAt: "2026-06-17T00:00:00Z",
    });
    expect(out.priceNumeric).toBe(4);
    expect(out.isDigital).toBe(true);
    expect(out.demandHistory).toHaveLength(1);
    expect(out.lastScrapedAt).toBe("2026-06-17T00:00:00Z");
  });

  it("maps hosted-shop snake_case rows", () => {
    const out = normalizeForShop({
      url: "u",
      title: "Mug",
      image_url: "m.jpg",
      is_digital: "false",
      info: "Selling fast",
      demand_value: "7",
      review_count: "1,002",
      favorites: "350",
      first_review: "2024-01-02",
      last_scraped_at: "2026-06-01T00:00:00Z",
      deleted: "true",
    });
    expect(out.imageUrl).toBe("m.jpg");
    expect(out.isDigital).toBe(false);
    expect(out.demandText).toBe("Selling fast");
    expect(out.reviewCount).toBe(1002);
    expect(out.favorites).toBe(350);
    expect(out.deleted).toBe(true);
  });
});

describe("getDemandValue", () => {
  it("uses demandValue, falls back to first int in info, then 0", () => {
    expect(getDemandValue(normalizeForShop({ url: "a", demandValue: 42 }))).toBe(42);
    expect(getDemandValue(normalizeForShop({ url: "a", info: "In 18 carts" }))).toBe(18);
    expect(getDemandValue(normalizeForShop({ url: "a", info: "Bestseller" }))).toBe(0);
  });
});

describe("getDemandIndicators + chip filter", () => {
  const row = normalizeForShop({
    url: "a",
    demandHistory: [
      { info: "In 20 carts", timestamp: "2026-06-17T00:00:00Z" },
      { info: "30 views in the last 24 hours", timestamp: "2026-06-16T00:00:00Z" },
    ],
  });

  it("returns all history entries for 'all'", () => {
    expect(getDemandIndicators(row, "all")).toHaveLength(2);
  });
  it("filters to matching entries for a chip", () => {
    expect(getDemandIndicators(row, "in_carts").map((e) => e.info)).toEqual(["In 20 carts"]);
    expect(getDemandIndicators(row, "views").map((e) => e.info)).toEqual(["30 views in the last 24 hours"]);
  });
  it("falls back to info when no history", () => {
    const r = normalizeForShop({ url: "a", info: "Selling fast", scrapedAt: "2026-06-01" });
    expect(getDemandIndicators(r, "all")).toEqual([{ info: "Selling fast", timestamp: "2026-06-01" }]);
  });
  it("demandInfoMatchesFilter recognizes selling_fast synonyms", () => {
    expect(demandInfoMatchesFilter("12 people bought this", "selling_fast")).toBe(true);
    expect(demandInfoMatchesFilter("In 5 carts", "selling_fast")).toBe(false);
  });
});

describe("review date parsing", () => {
  it("parses ISO, US, EU, and slash formats", () => {
    expect(parseReviewDate("2026-03-12")).toBe(new Date(2026, 2, 12).getTime());
    expect(parseReviewDate("Mar 12, 2026")).toBe(new Date(2026, 2, 12).getTime());
    expect(parseReviewDate("12 Mar, 2026")).toBe(new Date(2026, 2, 12).getTime());
    expect(parseReviewDate("None")).toBe(0);
    expect(parseReviewDate("LONG TIME AGO")).toBe(1);
  });
  it("formats to US short date, passing through non-dates", () => {
    expect(formatReviewDate("2026-03-12")).toBe("Mar 12, 2026");
    expect(formatReviewDate("None")).toBe("None");
  });

  it("rejects impossible slash dates instead of rolling over", () => {
    expect(parseReviewDate("13/13/2026")).toBe(0);
    expect(parseReviewDate("02/30/2026")).toBe(0); // Feb 30 doesn't exist
    expect(parseReviewDate("15/06/2026")).toBe(new Date(2026, 5, 15).getTime()); // DD/MM
  });
});

describe("sortListings", () => {
  const rows = [
    normalizeForShop({ url: "a", demandValue: 5, price: "10", favorites: 2, scrapedAt: "2026-01-01" }),
    normalizeForShop({ url: "b", demandValue: 50, price: "3", favorites: 99, scrapedAt: "2026-03-01" }),
    normalizeForShop({ url: "c", demandValue: 0, price: "7", favorites: 40, scrapedAt: "2026-02-01" }),
  ];
  it("demand desc / price asc / favorites desc / newest desc", () => {
    expect(sortListings(rows, "demand", "desc").map((r) => r.url)).toEqual(["b", "a", "c"]);
    expect(sortListings(rows, "price", "asc").map((r) => r.url)).toEqual(["b", "c", "a"]);
    expect(sortListings(rows, "favorites", "desc").map((r) => r.url)).toEqual(["b", "c", "a"]);
    expect(sortListings(rows, "newest", "desc").map((r) => r.url)).toEqual(["b", "c", "a"]);
  });
  it("puts null sort keys last even in asc", () => {
    const mixed = [
      normalizeForShop({ url: "noprice", price: "", scrapedAt: "2026-05-01" }),
      normalizeForShop({ url: "cheap", price: "$2", scrapedAt: "2026-04-01" }),
    ];
    expect(sortListings(mixed, "price", "asc").map((r) => r.url)).toEqual(["cheap", "noprice"]);
  });
  it("does not mutate input", () => {
    const copy = [...rows];
    sortListings(rows, "price", "asc");
    expect(rows).toEqual(copy);
  });
});

describe("filterShop", () => {
  const rows = [
    normalizeForShop({ url: "a", title: "Cat sticker", info: "In 20 carts", demandType: "in_carts" }),
    normalizeForShop({ url: "b", title: "Dog mug", info: "Selling fast", demandType: "sold_24h" }),
  ];
  it("search (comma terms) across title/info", () => {
    expect(filterShop(rows, { search: "cat" }).map((r) => r.title)).toEqual(["Cat sticker"]);
    expect(filterShop(rows, { search: "cat,dog" })).toHaveLength(2);
  });
  it("chip filters by demand semantics", () => {
    expect(filterShop(rows, { chip: "in_carts" }).map((r) => r.title)).toEqual(["Cat sticker"]);
    expect(filterShop(rows, { chip: "selling_fast" }).map((r) => r.title)).toEqual(["Dog mug"]);
  });
  it("demand text filter matches info + demand_type", () => {
    expect(filterShop(rows, { demand: "sold_24h" }).map((r) => r.title)).toEqual(["Dog mug"]);
  });
});

describe("dedupeForShop", () => {
  it("keeps one row per base URL, preferring non-deleted then newest", () => {
    const rows = [
      normalizeForShop({ url: "https://www.etsy.com/listing/1/a?ref=x", deleted: true, lastScrapedAt: "2026-06-10" }),
      normalizeForShop({ url: "https://www.etsy.com/listing/1/a", deleted: false, lastScrapedAt: "2026-06-05" }),
      normalizeForShop({ url: "https://www.etsy.com/listing/1/a/", deleted: false, lastScrapedAt: "2026-06-08" }),
    ];
    const out = dedupeForShop(rows);
    expect(out).toHaveLength(1);
    expect(out[0].deleted).toBe(false);
    expect(out[0].lastScrapedAt).toBe("2026-06-08");
  });

  it("keys by listingId when there is no URL, and tolerates missing timestamps", () => {
    const rows = [
      normalizeForShop({ listingId: "9", title: "A" }),
      normalizeForShop({ listingId: "9", title: "B" }),
      normalizeForShop({ listingId: "10", title: "C" }),
    ];
    const out = dedupeForShop(rows);
    expect(out).toHaveLength(2);
  });
});

describe("paginate + queryShop", () => {
  it("paginates with range + totals", () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ url: `u${i}` }));
    const p = paginate(rows, 2, 100);
    expect(p.pageRows).toHaveLength(100);
    expect(p.rangeStart).toBe(101);
    expect(p.rangeEnd).toBe(200);
    expect(p.totalPages).toBe(3);
  });
  it("queryShop runs dedupe -> filter -> sort -> paginate", () => {
    const rows = [
      { url: "https://www.etsy.com/listing/1/a", title: "Cat", demandValue: 9, scrapedAt: "2026-06-01" },
      { url: "https://www.etsy.com/listing/2/b", title: "Dog", demandValue: 99, scrapedAt: "2026-06-02" },
      { url: "https://www.etsy.com/listing/1/a?ref=z", title: "Cat", demandValue: 9, scrapedAt: "2026-05-01" },
    ];
    const res = queryShop(rows, { sort: "demand", dir: "desc", pageSize: 100 });
    expect(res.grandTotal).toBe(2);
    expect(res.pageRows[0].title).toBe("Dog");
  });
});
