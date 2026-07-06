import { describe, expect, it } from "vitest";
import { selectResumableJob, selectResumableJobForTerm, createJob } from "../src/core/jobs.js";

describe("createJob source tag (manual vs auto — audit deep-pass #13)", () => {
  it("defaults to manual and only 'auto' yields auto", () => {
    expect(createJob({ terms: "cat mug" }).source).toBe("manual");
    expect(createJob({ terms: "cat mug", source: "manual" }).source).toBe("manual");
    expect(createJob({ terms: "cat mug", source: "auto" }).source).toBe("auto");
    expect(createJob({ terms: "cat mug", source: "whatever" }).source).toBe("manual");
  });
});

describe("selectResumableJob", () => {
  it("prefers a live running job over anything else", () => {
    const jobs = [
      { id: "old", status: "paused", updatedAt: "2026-06-20T00:00:00Z" },
      { id: "live", status: "running", updatedAt: "2026-06-01T00:00:00Z" },
    ];
    expect(selectResumableJob(jobs).id).toBe("live");
  });

  it("falls back to the most recently updated unfinished job", () => {
    const jobs = [
      { id: "a", status: "paused", updatedAt: "2026-06-10T00:00:00Z" },
      { id: "b", status: "stopped", updatedAt: "2026-06-19T00:00:00Z" },
    ];
    expect(selectResumableJob(jobs).id).toBe("b");
  });

  it("NEVER resumes an error (circuit-breaker) job — re-hammering Etsy", () => {
    const jobs = [
      { id: "blocked", status: "error", updatedAt: "2026-06-20T00:00:00Z" },
      { id: "older", status: "paused", updatedAt: "2026-06-10T00:00:00Z" },
    ];
    // The error job is the most recent, but must be skipped for the paused one.
    expect(selectResumableJob(jobs).id).toBe("older");
  });

  it("returns null when only completed/error jobs exist", () => {
    const jobs = [
      { id: "done", status: "completed", updatedAt: "2026-06-20T00:00:00Z" },
      { id: "blocked", status: "error", updatedAt: "2026-06-19T00:00:00Z" },
    ];
    expect(selectResumableJob(jobs)).toBeNull();
  });

  it("resumes stopped and draft jobs (user-stoppable, not breaker-tripped)", () => {
    expect(selectResumableJob([{ id: "s", status: "stopped", updatedAt: "2026-06-20T00:00:00Z" }]).id).toBe("s");
    expect(selectResumableJob([{ id: "d", status: "draft", updatedAt: "2026-06-20T00:00:00Z" }]).id).toBe("d");
  });

  it("handles empty / non-array input", () => {
    expect(selectResumableJob([])).toBeNull();
    expect(selectResumableJob(null)).toBeNull();
    expect(selectResumableJob(undefined)).toBeNull();
  });

  it("falls back to createdAt when updatedAt is missing for ordering", () => {
    const jobs = [
      { id: "x", status: "paused", createdAt: "2026-06-05T00:00:00Z" },
      { id: "y", status: "paused", createdAt: "2026-06-18T00:00:00Z" },
    ];
    expect(selectResumableJob(jobs).id).toBe("y");
  });
});

describe("selectResumableJobForTerm", () => {
  it("returns the most recent unfinished job containing the term", () => {
    const jobs = [
      { id: "old", terms: ["cat mug"], status: "stopped", updatedAt: "2026-06-10T00:00:00Z" },
      { id: "new", terms: ["cat mug", "dog mug"], status: "stopped", updatedAt: "2026-06-20T00:00:00Z" },
    ];
    expect(selectResumableJobForTerm(jobs, "cat mug").id).toBe("new");
  });

  it("ignores completed/error jobs and jobs without the term", () => {
    const jobs = [
      { id: "done", terms: ["cat mug"], status: "completed", updatedAt: "2026-06-21T00:00:00Z" },
      { id: "err", terms: ["cat mug"], status: "error", updatedAt: "2026-06-22T00:00:00Z" },
      { id: "other", terms: ["dog mug"], status: "stopped", updatedAt: "2026-06-23T00:00:00Z" },
      { id: "ok", terms: ["cat mug"], status: "stopped", updatedAt: "2026-06-19T00:00:00Z" },
    ];
    expect(selectResumableJobForTerm(jobs, "cat mug").id).toBe("ok");
  });

  it("returns null when nothing matches or input is bad", () => {
    expect(selectResumableJobForTerm([{ id: "a", terms: ["x"], status: "completed" }], "x")).toBeNull();
    expect(selectResumableJobForTerm([], "x")).toBeNull();
    expect(selectResumableJobForTerm(null, "x")).toBeNull();
  });
});
