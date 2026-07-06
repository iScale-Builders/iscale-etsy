import { describe, it, expect } from "vitest";
import { buildQueueView } from "../src/core/queue-view.js";

describe("buildQueueView (dashboard remaining/failed view)", () => {
  it("counts remaining (pending+processing) per term and totals them", () => {
    const v = buildQueueView([
      { url: "u1", terms: ["a"], status: "pending", page: 1 },
      { url: "u2", terms: ["a"], status: "processing", page: 1 },
      { url: "u3", terms: ["b"], status: "pending", page: 2 },
    ]);
    expect(v.total).toBe(3);
    expect(v.counts).toEqual({ a: 2, b: 1 });
    expect(v.urls).toHaveLength(3);
  });

  it("surfaces done rows ONLY for terms that still have work", () => {
    const v = buildQueueView([
      { url: "u1", terms: ["active"], status: "pending", page: 1 },
      { url: "u2", terms: ["active"], status: "done", page: 1 }, // shown (active term)
      { url: "u3", terms: ["finished"], status: "done", page: 1 }, // hidden (no work left)
    ]);
    expect(v.doneCounts).toEqual({ active: 1 });
    expect(v.urls.some((r) => r.term === "finished")).toBe(false);
    expect(v.total).toBe(1); // only the pending one counts as remaining
  });

  it("excludes user-deleted 'removed' tombstones entirely", () => {
    const v = buildQueueView([
      { url: "u1", terms: ["a"], status: "pending", page: 1 },
      { url: "u2", terms: ["a"], status: "removed", page: 1 },
    ]);
    expect(v.total).toBe(1);
    expect(v.urls.map((r) => r.url)).toEqual(["u1"]);
  });

  it("fans a multi-term URL out to each of its terms", () => {
    const v = buildQueueView([{ url: "u1", terms: ["a", "b"], status: "pending", page: 1 }]);
    expect(v.counts).toEqual({ a: 1, b: 1 });
    expect(v.total).toBe(2);
  });

  it("separates failed rows into their own block with per-term counts", () => {
    const v = buildQueueView([
      { url: "u1", terms: ["a"], status: "failed", page: 1 },
      { url: "u2", terms: ["a"], status: "pending", page: 1 },
    ]);
    expect(v.failed.total).toBe(1);
    expect(v.failed.counts).toEqual({ a: 1 });
    expect(v.total).toBe(1); // failed not counted as remaining
  });

  it("caps the rendered list but keeps exact counts (cap is display-only)", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ url: `u${i}`, terms: ["a"], status: "pending", page: 1 }));
    const v = buildQueueView(rows, 2);
    expect(v.urls).toHaveLength(2); // capped render
    expect(v.capped).toBe(true);
    expect(v.total).toBe(5); // true count preserved
    expect(v.counts).toEqual({ a: 5 });
  });

  it("falls back to the legacy scalar term for pre-migration rows", () => {
    const v = buildQueueView([{ url: "u1", searchTerm: "legacy", status: "pending", page: 1 }]);
    expect(v.counts).toEqual({ legacy: 1 });
  });
});
