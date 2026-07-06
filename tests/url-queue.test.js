import { describe, expect, it } from "vitest";
import { urlQueueId, mergeQueueDiscovery, addTermToRow, collapseQueueRows, isLegacyQueueRow } from "../src/core/url-queue.js";

const A = "https://www.etsy.com/listing/1234567890/cat-mug";
const A_VARIANT = "https://www.etsy.com/listing/1234567890/cat-mug?click=1&ref=x";
const B = "https://www.etsy.com/listing/2222222222/dog-mug";

describe("urlQueueId", () => {
  it("is stable and collapses tracking-param variants of the same listing", () => {
    expect(urlQueueId(A)).toBe(urlQueueId(A_VARIANT)); // same normalized URL → same key
    expect(urlQueueId(A)).not.toBe(urlQueueId(B));
    expect(urlQueueId(A)).toMatch(/^q_/);
  });
});

describe("mergeQueueDiscovery", () => {
  const now = "2026-06-26T12:00:00.000Z";

  it("creates a pending row for a new URL with its term and page", () => {
    const row = mergeQueueDiscovery(null, { url: A, term: "cat mug", page: 3, source: "batch" }, now);
    expect(row.id).toBe(urlQueueId(A));
    expect(row.status).toBe("pending");
    expect(row.terms).toEqual(["cat mug"]);
    expect(row.term).toBe("cat mug");
    expect(row.page).toBe(3);
    expect(row.firstSeenAt).toBe(now);
  });

  it("unions terms, keeps the lowest page, and preserves firstSeenAt on re-discovery", () => {
    const first = mergeQueueDiscovery(null, { url: A, term: "cat mug", page: 5 }, "2026-06-25T00:00:00.000Z");
    const second = mergeQueueDiscovery(first, { url: A, term: "gift mug", page: 2 }, now);
    expect(second.terms).toEqual(["cat mug", "gift mug"]);
    expect(second.page).toBe(2);
    expect(second.firstSeenAt).toBe("2026-06-25T00:00:00.000Z");
    expect(second.status).toBe("pending");
  });
});

describe("addTermToRow", () => {
  it("adds a new term without touching status; no-ops when already present", () => {
    const row = { id: "q_x", status: "done", terms: ["a"], term: "a", searchTerm: "a" };
    const added = addTermToRow(row, "b", "2026-06-26T12:00:00.000Z");
    expect(added.terms).toEqual(["a", "b"]);
    expect(added.status).toBe("done");
    expect(addTermToRow(added, "b", "now")).toBe(added); // unchanged reference when present
  });
});

describe("collapseQueueRows", () => {
  const now = "2026-06-26T12:00:00.000Z";

  it("collapses per-job rows of one URL into a single row, unioning terms", () => {
    const rows = collapseQueueRows(
      [
        { id: "url_job1_aaa", url: A, status: "pending", searchTerm: "cat mug", page: 4, createdAt: "2026-06-20T00:00:00Z" },
        { id: "url_job2_aaa", url: A_VARIANT, status: "failed", searchTerm: "gift mug", page: 2, createdAt: "2026-06-22T00:00:00Z" },
        { id: "url_job3_bbb", url: B, status: "done", searchTerm: "dog mug", page: 1, createdAt: "2026-06-21T00:00:00Z" },
      ],
      now,
    );
    expect(rows).toHaveLength(2); // A + A_VARIANT collapse to one
    const a = rows.find((r) => r.id === urlQueueId(A));
    expect(a.terms).toEqual(["cat mug", "gift mug"]);
    expect(a.status).toBe("pending"); // pending beats failed
    expect(a.page).toBe(2); // lowest page
    expect(a.firstSeenAt).toBe("2026-06-20T00:00:00Z"); // earliest
  });

  it("picks the most advanced status and resets processing to pending", () => {
    const done = collapseQueueRows([
      { id: "url_j1_x", url: A, status: "pending", searchTerm: "t" },
      { id: "url_j2_x", url: A, status: "done", searchTerm: "t" },
    ], now);
    expect(done[0].status).toBe("done"); // done beats pending

    const reset = collapseQueueRows([{ id: "url_j_x", url: A, status: "processing", searchTerm: "t" }], now);
    expect(reset[0].status).toBe("pending"); // interrupted visit retried

    const failed = collapseQueueRows([{ id: "url_j_x", url: A, status: "failed", searchTerm: "t" }], now);
    expect(failed[0].status).toBe("failed"); // all-failed stays failed
  });
});

describe("isLegacyQueueRow", () => {
  it("recognizes legacy per-job ids vs canonical ids", () => {
    expect(isLegacyQueueRow({ id: "url_job1_abc" })).toBe(true);
    expect(isLegacyQueueRow({ id: "q_abc" })).toBe(false);
    expect(isLegacyQueueRow(null)).toBe(false);
  });
});
