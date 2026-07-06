// The storage layer had ZERO coverage. These tests run against fake-indexeddb,
// pinning the v4 migration (jobId index, non-unique normalizedUrl), single-tx
// bulkPut, the by-index queries that replaced full-store scans, and commit
// semantics (writes resolve only after the transaction commits).
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  openScraperDb,
  putRecord,
  getRecord,
  getAllRecords,
  getAllByIndex,
  bulkPut,
  countRecords,
  deleteRecord,
  clearStore,
  reduceRecords,
} from "../src/core/storage.js";

beforeEach(async () => {
  await clearStore("listings");
  await clearStore("listing_urls");
});

describe("storage migration (v4)", () => {
  it("creates the listing_urls jobId index", async () => {
    const db = await openScraperDb();
    const idxNames = db.transaction("listing_urls", "readonly").objectStore("listing_urls").indexNames;
    expect([...idxNames]).toContain("jobId");
  });

  it("keeps normalizedUrl NON-unique", async () => {
    const db = await openScraperDb();
    const index = db.transaction("listings", "readonly").objectStore("listings").index("normalizedUrl");
    expect(index.unique).toBe(false);
  });

  it("opens every declared store", async () => {
    const db = await openScraperDb();
    for (const store of ["jobs", "search_terms", "listing_urls", "listings", "settings", "search_results"]) {
      expect(db.objectStoreNames.contains(store)).toBe(true);
    }
  });
});

describe("putRecord / getRecord / count / delete", () => {
  it("round-trips a record", async () => {
    await putRecord("listings", { id: "a", title: "Linen Apron" });
    expect((await getRecord("listings", "a")).title).toBe("Linen Apron");
  });

  it("resolves a write only after it is readable (committed)", async () => {
    await putRecord("listings", { id: "commit-check", n: 1 });
    // If putRecord resolved before commit, this immediate read could miss it.
    expect(await getRecord("listings", "commit-check")).toEqual({ id: "commit-check", n: 1 });
  });

  it("counts without materializing rows", async () => {
    await bulkPut("listings", [{ id: "c1" }, { id: "c2" }, { id: "c3" }]);
    expect(await countRecords("listings")).toBe(3);
  });

  it("deletes a record", async () => {
    await putRecord("listings", { id: "d1" });
    await deleteRecord("listings", "d1");
    expect(await getRecord("listings", "d1")).toBeUndefined();
  });
});

describe("bulkPut", () => {
  it("writes every record and returns the count", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: `b${i}`, n: i }));
    expect(await bulkPut("listings", rows)).toBe(250);
    expect((await getAllRecords("listings")).length).toBe(250);
  });

  it("is a no-op on an empty / non-array input", async () => {
    expect(await bulkPut("listings", [])).toBe(0);
    expect(await bulkPut("listings", null)).toBe(0);
    expect((await getAllRecords("listings")).length).toBe(0);
  });

  it("overwrites existing rows by key (put semantics)", async () => {
    await bulkPut("listings", [{ id: "x", v: 1 }]);
    await bulkPut("listings", [{ id: "x", v: 2 }]);
    expect((await getRecord("listings", "x")).v).toBe(2);
    expect(await countRecords("listings")).toBe(1);
  });
});

describe("reduceRecords", () => {
  it("folds the store in one pass (collectionStats-style tally)", async () => {
    await bulkPut("listings", [
      { id: "r1", isDigital: true, demandValue: 5 },
      { id: "r2", isDigital: false, demandText: "In 3 carts" },
      { id: "r3", isDigital: true, demandValue: 0 },
      { id: "r4", isDigital: false },
    ]);
    const tally = await reduceRecords(
      "listings",
      (acc, row) => ({
        total: acc.total + 1,
        digital: acc.digital + (row.isDigital === true ? 1 : 0),
        withDemand: acc.withDemand + (row.demandValue > 0 || row.demandText ? 1 : 0),
      }),
      { total: 0, digital: 0, withDemand: 0 },
    );
    expect(tally).toEqual({ total: 4, digital: 2, withDemand: 2 });
  });

  it("returns the initial accumulator for an empty store", async () => {
    expect(await reduceRecords("listings", (a) => a + 1, 0)).toBe(0);
  });
});

describe("getAllByIndex(listing_urls, jobId)", () => {
  it("returns only the rows for the requested job", async () => {
    await bulkPut("listing_urls", [
      { id: "u1", jobId: "job_A", status: "pending" },
      { id: "u2", jobId: "job_A", status: "done" },
      { id: "u3", jobId: "job_B", status: "pending" },
    ]);
    const forA = await getAllByIndex("listing_urls", "jobId", "job_A");
    expect(forA.map((r) => r.id).sort()).toEqual(["u1", "u2"]);
    // status is filtered in memory by the caller — confirm the slice it needs.
    expect(forA.filter((r) => r.status === "pending").map((r) => r.id)).toEqual(["u1"]);
  });

  it("returns an empty array for an unknown job", async () => {
    await bulkPut("listing_urls", [{ id: "u9", jobId: "job_A", status: "pending" }]);
    expect(await getAllByIndex("listing_urls", "jobId", "job_ZZZ")).toEqual([]);
  });
});
