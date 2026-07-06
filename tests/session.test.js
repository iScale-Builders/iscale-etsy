import { describe, it, expect } from "vitest";
import { aggregateSession, blankSessionTally, foldSessionUrl } from "../src/core/session.js";

describe("aggregateSession", () => {
  const terms = [
    { id: "term_a", term: "cat mug", lastRunAt: "2026-06-17T00:00:00Z" },
    { id: "term_b", term: "dog shirt", lastRunAt: "" },
  ];
  const listingUrls = [
    { id: "u1", searchTerm: "cat mug", status: "done" },
    { id: "u2", searchTerm: "cat mug", status: "done" },
    { id: "u3", searchTerm: "cat mug", status: "pending" },
    { id: "u4", searchTerm: "cat mug", status: "failed" },
    { id: "u5", searchTerm: "dog shirt", status: "processing" },
  ];
  const jobs = [
    { id: "job1", status: "running", searchDone: ["cat mug|1", "cat mug|2", "dog shirt|1"], updatedAt: "2026-06-17T01:00:00Z" },
  ];

  it("aggregates per-term counts from durable listing_urls", () => {
    const out = aggregateSession({ terms, listingUrls, jobs, listingsTotal: 42, searchResultsTotal: 99 });
    const cat = out.terms.find((t) => t.term === "cat mug");
    expect(cat).toMatchObject({ found: 4, done: 2, pending: 1, failed: 1, pagesSearched: 2 });
    const dog = out.terms.find((t) => t.term === "dog shirt");
    expect(dog).toMatchObject({ found: 1, processing: 1, pagesSearched: 1 });
  });

  it("computes totals and surfaces the active job + carried totals", () => {
    const out = aggregateSession({ terms, listingUrls, jobs, listingsTotal: 42, searchResultsTotal: 99 });
    expect(out.totals).toEqual({ found: 5, done: 2, failed: 1, pending: 1, processing: 1 });
    expect(out.listingsTotal).toBe(42);
    expect(out.searchResultsTotal).toBe(99);
    expect(out.activeJob).toMatchObject({ id: "job1", status: "running", pagesDone: 3 });
  });

  it("surfaces terms from a running job even if not in the queue store", () => {
    const out = aggregateSession({
      terms: [],
      listingUrls: [{ id: "x", searchTerm: "legacy term", status: "done" }],
      jobs: [{ id: "j", status: "running", terms: ["legacy term"], searchDone: ["legacy term|1"] }],
    });
    const row = out.terms.find((t) => t.term === "legacy term");
    expect(row).toMatchObject({ term: "legacy term", running: true, found: 1, done: 1, pagesSearched: 1 });
  });

  it("handles an empty session", () => {
    const out = aggregateSession({});
    expect(out.terms).toEqual([]);
    expect(out.totals).toEqual({ found: 0, done: 0, failed: 0, pending: 0, processing: 0 });
    expect(out.activeJob).toBe(null);
  });

  it("excludes user-deleted 'removed' tombstones from all counts", () => {
    const out = aggregateSession({
      terms: [{ id: "t", term: "cat mug" }],
      listingUrls: [
        { id: "a", searchTerm: "cat mug", status: "done" },
        { id: "b", searchTerm: "cat mug", status: "removed" }, // user-deleted — must not count
        { id: "c", searchTerm: "cat mug", status: "removed" },
      ],
      jobs: [],
    });
    const cat = out.terms.find((t) => t.term === "cat mug");
    expect(cat).toMatchObject({ found: 1, done: 1, pending: 0 }); // tombstones invisible
    expect(out.totals).toEqual({ found: 1, done: 1, failed: 0, pending: 0, processing: 0 });
  });

  it("credits a URL to EVERY term in terms[] so pill counts match the queue (deep-pass Med #6)", () => {
    const out = aggregateSession({
      terms: [
        { id: "t1", term: "dog tshirt" },
        { id: "t2", term: "pet tshirt" },
      ],
      // One URL shared by both terms (terms[]), plus one unique to dog tshirt.
      listingUrls: [
        { id: "shared", terms: ["pet tshirt", "dog tshirt"], searchTerm: "pet tshirt", status: "pending" },
        { id: "dogonly", terms: ["dog tshirt"], searchTerm: "dog tshirt", status: "done" },
      ],
      jobs: [],
    });
    const dog = out.terms.find((t) => t.term === "dog tshirt");
    const pet = out.terms.find((t) => t.term === "pet tshirt");
    // Before the fix, the shared URL credited only its scalar (pet) → dog showed found:1.
    expect(dog).toMatchObject({ found: 2, done: 1, pending: 1 }); // both URLs counted for dog
    expect(pet).toMatchObject({ found: 1, pending: 1 }); // shared URL counted for pet too
    // …but the rollup counts each URL ONCE (no double-count for the shared one).
    expect(out.totals).toEqual({ found: 2, done: 1, failed: 0, pending: 1, processing: 0 });
  });
});

// sessionStatus in background.js streams listing_urls through foldSessionUrl
// (cursor pass) instead of materializing the array. The two paths must stay
// interchangeable — this locks their parity on every status/term shape.
describe("foldSessionUrl streaming parity with the array path", () => {
  it("pre-folded urlTally produces the identical snapshot", () => {
    const terms = [
      { id: "1", term: "dog", lastRunAt: "2026-07-01" },
      { id: "2", term: "pet", lastRunAt: "" },
    ];
    const listingUrls = [
      { url: "a", status: "done", terms: ["dog", "pet"] },
      { url: "b", status: "pending", searchTerm: "dog" },
      { url: "c", status: "failed", term: "pet" },
      { url: "d", status: "processing", terms: ["dog"] },
      { url: "e", status: "removed", terms: ["dog"] }, // tombstone: excluded everywhere
      { url: "f", status: "pending" }, // legacy row with no term at all
    ];
    const jobs = [{ id: "j1", status: "running", terms: ["dog"], searchDone: ["dog|1"] }];

    const fromRows = aggregateSession({ terms, listingUrls, jobs, listingsTotal: 7, searchResultsTotal: 3 });
    const urlTally = listingUrls.reduce(foldSessionUrl, blankSessionTally());
    const fromTally = aggregateSession({ terms, urlTally, jobs, listingsTotal: 7, searchResultsTotal: 3 });

    expect(fromTally).toEqual(fromRows);
    expect(fromTally.totals).toEqual({ found: 5, done: 1, failed: 1, pending: 2, processing: 1 });
  });
});
