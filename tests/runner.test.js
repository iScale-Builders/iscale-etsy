import { describe, expect, it } from "vitest";
import { betweenTermsGate, eligibleTerms, failedToAutoRetry, getJobSearchUrls, makeListingQueueItems, nextRunnerStep, planJobSteps, planTick, recentBlockError, shouldContinueTerm, shouldStartNewCycle } from "../src/core/runner.js";

describe("failedToAutoRetry (auto-retry failed URLs when auto-run is idle)", () => {
  const rows = [
    { url: "a", status: "failed", terms: ["dog tshirt"] },
    { url: "b", status: "failed", terms: ["dog tshirt", "pet tshirt"], autoRetries: 1 },
    { url: "c", status: "failed", terms: ["cat mug"], autoRetries: 2 }, // at cap
    { url: "d", status: "done", terms: ["dog tshirt"] },
    { url: "e", status: "pending", terms: ["dog tshirt"] },
    { url: "f", status: "failed", searchTerm: "legacy" }, // scalar fallback
  ];
  it("returns nothing when the cap is 0 (feature off)", () => {
    expect(failedToAutoRetry(rows, 0)).toEqual({ urls: [], terms: [] });
  });
  it("picks failed URLs still UNDER the cap and their terms", () => {
    const out = failedToAutoRetry(rows, 2);
    expect(out.urls.map((u) => u.url).sort()).toEqual(["a", "b", "f"]); // c is at cap → excluded
    expect(out.terms.sort()).toEqual(["dog tshirt", "legacy", "pet tshirt"]);
  });
  it("excludes done/pending rows and rows at/over the cap", () => {
    const out = failedToAutoRetry(rows, 1);
    expect(out.urls.map((u) => u.url).sort()).toEqual(["a", "f"]); // b(autoRetries1) now at cap
  });
  it("handles empty / bad input", () => {
    expect(failedToAutoRetry([], 2)).toEqual({ urls: [], terms: [] });
    expect(failedToAutoRetry(null, 2)).toEqual({ urls: [], terms: [] });
  });
});

describe("recentBlockError (eviction-proof post-block cooldown, derived from the error job)", () => {
  const NOW = 1_000_000;
  const errJob = (overrides) => ({ status: "error", reason: "too_many_consecutive_failures", updatedAt: new Date(NOW - 60_000).toISOString(), ...overrides });
  it("true while a too-many-failures error job is younger than the cooldown", () => {
    expect(recentBlockError([errJob()], 300_000, NOW)).toBe(true);
  });
  it("false once the error job is older than the cooldown", () => {
    expect(recentBlockError([errJob({ updatedAt: new Date(NOW - 600_000).toISOString() })], 300_000, NOW)).toBe(false);
  });
  it("ignores error jobs with a different reason, and non-error jobs", () => {
    expect(recentBlockError([errJob({ reason: "other" })], 300_000, NOW)).toBe(false);
    expect(recentBlockError([{ status: "running" }, { status: "completed" }], 300_000, NOW)).toBe(false);
  });
  it("false when cooldown is 0 or there are no jobs", () => {
    expect(recentBlockError([errJob()], 0, NOW)).toBe(false);
    expect(recentBlockError([], 300_000, NOW)).toBe(false);
  });
});

describe("betweenTermsGate (separate, opt-in pause between search terms)", () => {
  it("is OFF by default — betweenMs<=0 never pauses (zero behavior change)", () => {
    expect(betweenTermsGate({ betweenMs: 0, nextType: "visit", nextTerm: "b", currentTerm: "a", nowMs: 1000 })).toEqual({ gated: false });
  });
  it("never pauses when the run is finishing", () => {
    expect(betweenTermsGate({ betweenMs: 60000, nextType: "done", currentTerm: "a", nowMs: 1000 })).toEqual({ gated: false });
  });
  it("first term of a run: records it, no pause", () => {
    expect(betweenTermsGate({ betweenMs: 60000, nextType: "visit", nextTerm: "a", currentTerm: "", nowMs: 1000 })).toEqual({ gated: false, setCurrentTerm: "a" });
  });
  it("same term still in progress: no pause", () => {
    expect(betweenTermsGate({ betweenMs: 60000, nextType: "visit", nextTerm: "a", currentTerm: "a", nowMs: 1000 })).toEqual({ gated: false });
  });
  it("term→term transition starts the pause with a finite deadline", () => {
    expect(betweenTermsGate({ betweenMs: 60000, nextType: "visit", nextTerm: "b", currentTerm: "a", termGapUntil: 0, nowMs: 1000 })).toEqual({ gated: true, setGapUntil: 61000 });
  });
  it("keeps pausing while the deadline is in the future", () => {
    expect(betweenTermsGate({ betweenMs: 60000, nextType: "visit", nextTerm: "b", currentTerm: "a", termGapUntil: 61000, nowMs: 30000 })).toEqual({ gated: true });
  });
  it("once the deadline passes, enters the new term and clears the gap", () => {
    expect(betweenTermsGate({ betweenMs: 60000, nextType: "visit", nextTerm: "b", currentTerm: "a", termGapUntil: 61000, nowMs: 61000 })).toEqual({ gated: false, setCurrentTerm: "b", setGapUntil: 0 });
  });

  // The gate is now evaluated at the TRUE term boundary — the first actionable step of a
  // new term, which is usually a SEARCH (not a visit). These lock that the same logic
  // holds for search-type steps, so the pause covers the next term's searches too and is
  // armed even when a term has no visits (e.g. all listings already scraped today).
  it("arms currentTerm on the term's first SEARCH step (no pause on the first term)", () => {
    expect(betweenTermsGate({ betweenMs: 120000, nextType: "search", nextTerm: "a", currentTerm: "", nowMs: 1000 })).toEqual({ gated: false, setCurrentTerm: "a" });
  });
  it("pauses BEFORE the next term's searches start (search-type transition)", () => {
    expect(betweenTermsGate({ betweenMs: 120000, nextType: "search", nextTerm: "b", currentTerm: "a", termGapUntil: 0, nowMs: 1000 })).toEqual({ gated: true, setGapUntil: 121000 });
  });
  it("holds the pause across search-step re-checks until the deadline", () => {
    expect(betweenTermsGate({ betweenMs: 120000, nextType: "search", nextTerm: "b", currentTerm: "a", termGapUntil: 121000, nowMs: 60000 })).toEqual({ gated: true });
  });
  it("releases into the new term on a search step once the deadline passes", () => {
    expect(betweenTermsGate({ betweenMs: 120000, nextType: "search", nextTerm: "b", currentTerm: "a", termGapUntil: 121000, nowMs: 121000 })).toEqual({ gated: false, setCurrentTerm: "b", setGapUntil: 0 });
  });
});

describe("eligibleTerms (auto-run only works terms NOT already done today)", () => {
  const NOW = Date.parse("2026-06-27T15:00:00Z");
  const today = "2026-06-27T09:00:00Z";
  const yesterday = "2026-06-26T23:00:00Z";

  it("returns all terms (in createdAt order) when none are done today", () => {
    const rows = [
      { term: "b", createdAt: "2026-06-01T00:00:02Z" },
      { term: "a", createdAt: "2026-06-01T00:00:01Z" },
    ];
    expect(eligibleTerms(rows, NOW)).toEqual(["a", "b"]);
  });

  it("excludes a term already completed today", () => {
    const rows = [
      { term: "a", createdAt: "t1", lastDoneAt: today },
      { term: "b", createdAt: "t2" },
    ];
    expect(eligibleTerms(rows, NOW)).toEqual(["b"]);
  });

  it("a term added mid-run (no stamp) is eligible and comes after the done ones", () => {
    const rows = [
      { term: "cute hoodie", createdAt: "t1", lastDoneAt: today },
      { term: "ugly sweater", createdAt: "t2", lastDoneAt: today },
      { term: "cute tank top summer", createdAt: "t9" }, // added later, not done
    ];
    expect(eligibleTerms(rows, NOW)).toEqual(["cute tank top summer"]);
  });

  it("yesterday's completion is eligible again today (daily refresh)", () => {
    expect(eligibleTerms([{ term: "a", createdAt: "t1", lastDoneAt: yesterday }], NOW)).toEqual(["a"]);
  });

  it("returns [] when every term is done today, and tolerates junk rows", () => {
    expect(eligibleTerms([{ term: "a", createdAt: "t1", lastDoneAt: today }], NOW)).toEqual([]);
    expect(eligibleTerms([null, { createdAt: "t1" }], NOW)).toEqual([]); // no term field
  });
});

// NOTE: planTick/nextRunnerStep are a RESERVED durable-cursor engine NOT wired into the
// live runner (background.js uses planJobSteps). These tests cover that future engine, not
// the shipping runner — see the ⚠️ banner in runner.js. (audit HIGH-2)
describe("planTick (the alarm engine's pure brain — decides one action from durable state)", () => {
  const job = (over = {}) => ({ terms: ["a", "b"], pagesPerTerm: 2, searchDone: [], ...over });
  const row = (url, status, terms) => ({ url, status, terms });

  it("returns done with no job / no terms", () => {
    expect(planTick({})).toEqual({ type: "done" });
    expect(planTick({ job: { terms: [] } })).toEqual({ type: "done" });
  });

  it("discovers the first un-walked page of the first term", () => {
    expect(planTick({ job: job({ searchDone: [] }) })).toEqual({ type: "discover", term: "a", page: 1 });
    expect(planTick({ job: job({ searchDone: ["a|1"] }) })).toEqual({ type: "discover", term: "a", page: 2 });
  });

  it("visits once a term's pages are all walked and it has pending URLs", () => {
    const j = job({ searchDone: ["a|1", "a|2"] });
    const urlRows = [row("u1", "pending", ["a"]), row("u2", "done", ["a"])];
    expect(planTick({ job: j, urlRows })).toEqual({ type: "visit", term: "a" });
  });

  it("moves to the next term only after the first is fully drained", () => {
    const j = job({ searchDone: ["a|1", "a|2", "b|1"] });
    // term a fully walked + nothing pending → advance to b's next page
    const urlRows = [row("u1", "done", ["a"])];
    expect(planTick({ job: j, urlRows })).toEqual({ type: "discover", term: "b", page: 2 });
  });

  it("is done when every term is walked and nothing is pending", () => {
    const j = job({ searchDone: ["a|1", "a|2", "b|1", "b|2"] });
    expect(planTick({ job: j, urlRows: [row("u1", "done", ["a"])] })).toEqual({ type: "done" });
  });

  it("counts a URL's pending status under EACH of its terms (shared listings)", () => {
    const j = job({ searchDone: ["a|1", "a|2", "b|1", "b|2"] });
    const urlRows = [row("shared", "pending", ["a", "b"])];
    // first term with work wins → a
    expect(planTick({ job: j, urlRows })).toEqual({ type: "visit", term: "a" });
  });

  it("falls back to searchTerm/term when a row has no terms[] array", () => {
    const j = job({ terms: ["x"], pagesPerTerm: 1, searchDone: ["x|1"] });
    expect(planTick({ job: j, urlRows: [{ url: "u", status: "pending", searchTerm: "x" }] })).toEqual({ type: "visit", term: "x" });
  });

  it("skips cancelled terms", () => {
    const j = job({ searchDone: ["a|1", "a|2", "b|1", "b|2"] });
    const urlRows = [row("ua", "pending", ["a"]), row("ub", "pending", ["b"])];
    expect(planTick({ job: j, urlRows, cancelled: ["a"] })).toEqual({ type: "visit", term: "b" });
  });

  it("ignores non-pending rows when counting work", () => {
    const j = job({ terms: ["a"], pagesPerTerm: 1, searchDone: ["a|1"] });
    const urlRows = [row("u1", "done", ["a"]), row("u2", "failed", ["a"]), row("u3", "processing", ["a"])];
    expect(planTick({ job: j, urlRows })).toEqual({ type: "done" }); // nothing "pending"
  });
});

describe("shouldStartNewCycle (stop auto-run from switching terms mid-run)", () => {
  it("starts a new cycle only when NO job is in flight", () => {
    expect(shouldStartNewCycle([])).toBe(true);
    expect(shouldStartNewCycle([{ status: "completed" }, { status: "stopped" }, { status: "error" }])).toBe(true);
  });
  it("does NOT start a new term while a job is still running (interrupted by a worker death)", () => {
    expect(shouldStartNewCycle([{ status: "completed" }, { status: "running" }])).toBe(false);
  });
  it("does NOT start a new term while a job is paused", () => {
    expect(shouldStartNewCycle([{ status: "paused" }])).toBe(false);
  });
  it("tolerates null/garbage job rows", () => {
    expect(shouldStartNewCycle([null, undefined, { status: "completed" }])).toBe(true);
  });
});

describe("nextRunnerStep (the alarm-driven runner's durable-cursor brain)", () => {
  const P = 2;
  it("returns done when there are no terms", () => {
    expect(nextRunnerStep({ terms: [], pagesPerTerm: P })).toEqual({ type: "done" });
  });
  it("discovers the lowest un-walked page first", () => {
    expect(nextRunnerStep({ terms: ["a"], pagesPerTerm: P, walkedByTerm: {} })).toEqual({ type: "discover", term: "a", page: 1 });
    expect(nextRunnerStep({ terms: ["a"], pagesPerTerm: P, walkedByTerm: { a: [1] } })).toEqual({ type: "discover", term: "a", page: 2 });
  });
  it("is robust to gaps in walked pages (returns the missing page, not count+1)", () => {
    expect(nextRunnerStep({ terms: ["a"], pagesPerTerm: 3, walkedByTerm: { a: [1, 3] } })).toEqual({ type: "discover", term: "a", page: 2 });
  });
  it("visits only after every page is walked, and while pending remain", () => {
    expect(nextRunnerStep({ terms: ["a"], pagesPerTerm: P, walkedByTerm: { a: [1, 2] }, pendingByTerm: { a: 5 } })).toEqual({ type: "visit", term: "a" });
  });
  it("marks a term finished (all pages walked, nothing pending) and moves to the next term", () => {
    const step = nextRunnerStep({ terms: ["a", "b"], pagesPerTerm: P, walkedByTerm: { a: [1, 2] }, pendingByTerm: { a: 0 } });
    expect(step).toEqual({ type: "discover", term: "b", page: 1 });
  });
  it("returns done when every term is fully walked with nothing pending", () => {
    expect(nextRunnerStep({ terms: ["a", "b"], pagesPerTerm: P, walkedByTerm: { a: [1, 2], b: [1, 2] }, pendingByTerm: {} })).toEqual({ type: "done" });
  });
  it("respects term order — the first term with work wins", () => {
    const step = nextRunnerStep({ terms: ["a", "b"], pagesPerTerm: P, walkedByTerm: { a: [1, 2], b: [1, 2] }, pendingByTerm: { a: 1, b: 1 } });
    expect(step).toEqual({ type: "visit", term: "a" });
  });
  it("skips cancelled terms (array or Set)", () => {
    const args = { terms: ["a", "b"], pagesPerTerm: P, walkedByTerm: { b: [1, 2] }, pendingByTerm: { b: 1 } };
    expect(nextRunnerStep({ ...args, cancelled: ["a"] })).toEqual({ type: "visit", term: "b" });
    expect(nextRunnerStep({ ...args, cancelled: new Set(["a"]) })).toEqual({ type: "visit", term: "b" });
  });
  it("accepts walkedByTerm as a Set as well as an array", () => {
    expect(nextRunnerStep({ terms: ["a"], pagesPerTerm: P, walkedByTerm: { a: new Set([1]) } })).toEqual({ type: "discover", term: "a", page: 2 });
  });
});

describe("shouldContinueTerm (continue-vs-fresh — the most-regressed runner logic)", () => {
  const P = 10;
  it("CONTINUES a fully-walked term that still has pending URLs to visit", () => {
    expect(shouldContinueTerm({ walkedCount: P, hasPending: true, pagesPerTerm: P })).toBe(true);
  });
  it("CONTINUES a partially-discovered term (un-walked pages remain)", () => {
    expect(shouldContinueTerm({ walkedCount: 4, hasPending: false, pagesPerTerm: P })).toBe(true);
    expect(shouldContinueTerm({ walkedCount: 4, hasPending: true, pagesPerTerm: P })).toBe(true);
  });
  it("re-discovers FRESH a fully-walked term with nothing pending (NOT a no-op)", () => {
    expect(shouldContinueTerm({ walkedCount: P, hasPending: false, pagesPerTerm: P })).toBe(false);
  });
  it("handles never-run / default inputs", () => {
    expect(shouldContinueTerm({ walkedCount: 0, hasPending: false, pagesPerTerm: P })).toBe(true); // 0 walked → seeds nothing = fresh
    expect(shouldContinueTerm()).toBe(false); // defaults: 0 walked, 0 pages
  });
});

describe("runner", () => {
  it("builds search URLs for each term and page", () => {
    const urls = getJobSearchUrls({
      terms: ["cat mug", "dog mug"],
      pagesPerTerm: 2,
      sort: "most_relevant",
    });

    expect(urls).toHaveLength(4);
    expect(urls[0]).toMatchObject({ term: "cat mug", page: 1 });
  });

  it("dedupes listing queue items", () => {
    const items = makeListingQueueItems(
      [
        "https://www.etsy.com/listing/1234567890/cat-mug?click=1",
        "https://www.etsy.com/listing/1234567890/cat-mug",
      ],
      { id: "job_1" },
      "cat mug",
      1,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      jobId: "job_1",
      searchTerm: "cat mug",
      status: "pending",
    });
  });

});

describe("planJobSteps (term-by-term ordering)", () => {
  it("finishes each term (all search pages, then visit) before the next term", () => {
    const steps = planJobSteps({ terms: ["cat mug", "dog mug"], pagesPerTerm: 2, sort: "most_relevant" });
    const shape = steps.map((s) => (s.type === "search" ? `search:${s.term}#${s.page}` : `visit:${s.term}`));

    expect(shape).toEqual([
      "search:cat mug#1",
      "search:cat mug#2",
      "visit:cat mug",
      "search:dog mug#1",
      "search:dog mug#2",
      "visit:dog mug",
    ]);
  });

  it("places a term's visit step before any later term's search step (the core invariant)", () => {
    const steps = planJobSteps({ terms: ["a", "b"], pagesPerTerm: 3 });
    const firstTermVisit = steps.findIndex((s) => s.type === "visit" && s.term === "a");
    const secondTermFirstSearch = steps.findIndex((s) => s.type === "search" && s.term === "b");

    expect(firstTermVisit).toBeGreaterThan(-1);
    expect(secondTermFirstSearch).toBeGreaterThan(firstTermVisit);
  });

  it("attaches a built search URL to each search step", () => {
    const steps = planJobSteps({ terms: ["cat mug"], pagesPerTerm: 1 });
    const search = steps.find((s) => s.type === "search");

    expect(search.url).toContain("cat");
    expect(search.url.startsWith("http")).toBe(true);
  });
});
