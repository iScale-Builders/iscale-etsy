import { describe, expect, it } from "vitest";
import { mergeImportedListings, rowsFromImportedCsv } from "../src/core/import-listings.js";

describe("import-listings", () => {
  it("normalizes imported csv rows into listing records", () => {
    const rows = rowsFromImportedCsv(
      "url,title,shopName,source\nhttps://www.etsy.com/listing/1234567890/cat-mug?click=1,Cat Mug,Best Shop,batch",
      "2026-06-15T12:00:00.000Z",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "listing_1234567890",
      listingId: "1234567890",
      normalizedUrl: "https://www.etsy.com/listing/1234567890/cat-mug",
      source: "batch",
      importedAt: "2026-06-15T12:00:00.000Z",
    });
  });

  it("merges imported rows into accumulated results", () => {
    const existing = [
      {
        id: "listing_1234567890",
        url: "https://www.etsy.com/listing/1234567890/cat-mug",
        normalizedUrl: "https://www.etsy.com/listing/1234567890/cat-mug",
        listingId: "1234567890",
        title: "Old title",
        source: "batch",
      },
    ];
    const imported = rowsFromImportedCsv(
      "url,title,shopName,source\nhttps://www.etsy.com/listing/1234567890/cat-mug,New title,Best Shop,csv_import\nhttps://www.etsy.com/listing/2222222222/dog-shirt,Dog Shirt,Dog Shop,csv_import",
      "2026-06-15T12:00:00.000Z",
    );

    const merged = mergeImportedListings(existing, imported);

    expect(merged.added).toBe(1);
    expect(merged.updated).toBe(1);
    expect(merged.rows).toHaveLength(2);
    expect(merged.rows.find((row) => row.listingId === "1234567890")).toMatchObject({
      title: "New title",
      shopName: "Best Shop",
    });
  });
});

describe("import-listings — audit fixes", () => {
  it("M-1: re-import keeps the existing record's id (no orphan under a new key)", () => {
    const existing = [
      {
        id: "listing_OLD",
        url: "https://www.etsy.com/listing/1234567890/cat-mug",
        normalizedUrl: "https://www.etsy.com/listing/1234567890/cat-mug",
        title: "Old",
      },
    ];
    const imported = rowsFromImportedCsv(
      "url,title\nhttps://www.etsy.com/listing/1234567890/cat-mug,New",
      "2026-06-20T00:00:00.000Z",
    );
    const merged = mergeImportedListings(existing, imported);
    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0].id).toBe("listing_OLD");
    expect(merged.rows[0].title).toBe("New");
  });

  it("M-1: collapses two existing rows that share a URL (no data loss, orphan reported)", () => {
    // A hash-id hosted-shop import AND a native listingId scrape of the SAME listing.
    const existing = [
      { id: "listing_abc123", url: "https://www.etsy.com/listing/1234567890/cat-mug", normalizedUrl: "https://www.etsy.com/listing/1234567890/cat-mug", title: "Hosted", shopName: "Best Shop" },
      { id: "listing_1234567890", url: "https://www.etsy.com/listing/1234567890/cat-mug", normalizedUrl: "https://www.etsy.com/listing/1234567890/cat-mug", title: "Native", reviewCount: "42" },
    ];
    const merged = mergeImportedListings(existing, []);
    // Both collapsed into ONE canonical (numeric-id) row — no existing row dropped.
    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0].id).toBe("listing_1234567890"); // canonical wins
    expect(merged.rows[0].shopName).toBe("Best Shop"); // data from the absorbed row preserved
    // The non-canonical id is reported so the caller deletes the orphan from the store.
    expect(merged.removedIds).toEqual(["listing_abc123"]);
  });

  it("M-1: no collisions → removedIds is empty", () => {
    const merged = mergeImportedListings(
      [{ id: "listing_1", url: "https://www.etsy.com/listing/1/a", normalizedUrl: "https://www.etsy.com/listing/1/a" }],
      [],
    );
    expect(merged.removedIds).toEqual([]);
    expect(merged.rows).toHaveLength(1);
  });

  it("M-5: firstSeenAt falls back to import time, not lastScrapedAt", () => {
    const [row] = rowsFromImportedCsv(
      "url,lastScrapedAt\nhttps://www.etsy.com/listing/1234567890/x,2026-06-19T00:00:00.000Z",
      "2026-06-20T12:00:00.000Z",
    );
    expect(row.lastScrapedAt).toBe("2026-06-19T00:00:00.000Z");
    expect(row.firstSeenAt).toBe("2026-06-20T12:00:00.000Z");
  });

  it("LOW: strips locale thousands separators from numeric fields", () => {
    const [row] = rowsFromImportedCsv(
      'url,favorites,reviewCount\nhttps://www.etsy.com/listing/1234567890/x,"1,234","2,500"',
      "2026-06-20T00:00:00.000Z",
    );
    expect(row.favorites).toBe("1234");
    expect(row.reviewCount).toBe("2500");
  });
});
