import { describe, it, expect } from "vitest";
import { rowsToCsv, DEFAULT_EXPORT_COLUMNS } from "../src/core/csv.js";
import { rowsFromImportedCsv } from "../src/core/import-listings.js";

describe("CSV round-trip of demand_history and accumulating fields", () => {
  it("serializes demandHistory as JSON and parses it back on import", () => {
    const record = {
      url: "https://www.etsy.com/listing/1234567890/cat-mug",
      title: "Cat Mug",
      price: "$12.99",
      favorites: 350,
      reviewCount: 1002,
      firstReview: "2024-01-02",
      demandText: "In 20 carts",
      demandType: "in_carts",
      demandValue: 20,
      demandHistory: [
        { date: "2026-06-17", timestamp: "2026-06-17T00:00:00Z", created_at: "2026-06-17T00:00:00Z", value: 20, type: "in_carts", info: "In 20 carts" },
        { date: "2026-06-16", timestamp: "2026-06-16T00:00:00Z", created_at: "2026-06-16T00:00:00Z", value: 14, type: "in_carts", info: "In 14 carts" },
      ],
      isDigital: false,
      deleted: false,
      scrapedAt: "2026-06-17T00:00:00Z",
    };

    const csv = rowsToCsv([record]);
    expect(DEFAULT_EXPORT_COLUMNS).toContain("demandHistory");

    const [back] = rowsFromImportedCsv(csv);
    expect(back.title).toBe("Cat Mug");
    // CSV cells round-trip as strings; normalizeForShop coerces them to numbers at render time.
    expect(back.favorites).toBe("350");
    expect(back.reviewCount).toBe("1002");
    expect(back.firstReview).toBe("2024-01-02");
    expect(Array.isArray(back.demandHistory)).toBe(true);
    expect(back.demandHistory).toHaveLength(2);
    expect(back.demandHistory[0].value).toBe(20);
  });

  it("round-trips every export column through rowsToCsv -> import", () => {
    const record = {
      url: "https://www.etsy.com/listing/1234567890/cat-mug",
      listingId: "1234567890",
      title: "Cat Mug",
      shopName: "MeowCo",
      price: "$12.99",
      currency: "USD",
      favorites: 350,
      reviewCount: 1002,
      firstReview: "2024-01-02",
      lastReview: "2026-06-01",
      demandText: "In 20 carts",
      demandType: "in_carts",
      demandValue: 20,
      demandHistory: [{ value: 20, info: "In 20 carts", timestamp: "2026-06-17T00:00:00Z" }],
      isDigital: false,
      deleted: false,
      deletedAt: "",
      source: "passive_browse",
      searchTerm: "cat mug",
      firstSeenAt: "2026-06-10T00:00:00Z",
      lastSeenAt: "2026-06-17T00:00:00Z",
      scrapedAt: "2026-06-17T00:00:00Z",
      lastScrapedAt: "2026-06-17T00:00:00Z",
    };
    const header = rowsToCsv([record]).split("\n")[0].split(",");
    expect(header).toEqual(DEFAULT_EXPORT_COLUMNS);

    const [back] = rowsFromImportedCsv(rowsToCsv([record]));
    expect(back.title).toBe("Cat Mug");
    expect(back.shopName).toBe("MeowCo");
    expect(back.currency).toBe("USD");
    expect(back.lastReview).toBe("2026-06-01");
    expect(back.searchTerm).toBe("cat mug");
    expect(back.demandHistory).toHaveLength(1);
  });

  it("imports a hosted-shop snake_case CSV (demand_history, review_count, is_digital)", () => {
    const csv = [
      "url,title,price,image_url,favorites,review_count,first_review,info,demand_type,demand_value,demand_history,is_digital,deleted",
      `https://www.etsy.com/listing/777777777/x,Mug,$9.00,m.jpg,12,4,2024-05-01,Selling fast,sold_24h,8,"[{""info"":""Selling fast"",""timestamp"":""2026-06-01T00:00:00Z"",""value"":8}]",false,false`,
    ].join("\n");
    const [row] = rowsFromImportedCsv(csv);
    expect(row.title).toBe("Mug");
    expect(row.reviewCount).toBe("4");
    expect(row.demandText).toBe("Selling fast");
    expect(row.demandHistory).toHaveLength(1);
    expect(row.demandHistory[0].info).toBe("Selling fast");
    expect(row.isDigital).toBe("false");
  });
});
