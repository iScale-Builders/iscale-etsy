import { describe, expect, it } from "vitest";
import { dispatchAction } from "../src/core/actions.js";

describe("actions", () => {
  it("estimates workload before a scrape job starts", async () => {
    const estimate = await dispatchAction("job.estimate", {
      terms: "cat mug\ndog mug",
      pages: 5,
    });

    expect(estimate.estimatedSearchPages).toBe(10);
    expect(estimate.estimatedListingCandidates).toBe(480);
    expect(estimate.largeJob).toBe(false);
  });

  it("creates jobs through the adapter", async () => {
    const saved = [];
    const result = await dispatchAction(
      "job.create",
      { terms: "cat mug", pages: 2, id: "job_test" },
      { saveJob: (job) => saved.push(job) },
    );

    expect(result.job.id).toBe("job_test");
    expect(saved).toHaveLength(1);
  });

  it("clears all queued terms through the adapter", async () => {
    let cleared = false;
    const result = await dispatchAction(
      "terms.clear",
      {},
      { clearTerms: async () => { cleared = true; return { terms: [] }; } },
    );

    expect(cleared).toBe(true);
    expect(result.terms).toEqual([]);
  });

  it("exposes terms.clear in the manifest", async () => {
    const manifest = await dispatchAction("manifest.get");
    expect(manifest.actions["terms.clear"]).toEqual({ mutates: true, approval: "none" });
  });
});

