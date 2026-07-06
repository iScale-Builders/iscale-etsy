import { parseSearchTerms } from "./etsy-url.js";

const DEFAULT_PAGES = 10;
const DEFAULT_LISTINGS_PER_PAGE = 48;

export function estimateJob(input = {}) {
  const terms = parseSearchTerms(input.terms || input.searchTerms || "");
  const pagesPerTerm = clampInteger(input.pagesPerTerm ?? input.pages, DEFAULT_PAGES, 1, 50);
  const listingsPerPage = clampInteger(input.listingsPerPage, DEFAULT_LISTINGS_PER_PAGE, 1, 100);
  const estimatedSearchPages = terms.length * pagesPerTerm;
  const estimatedListingCandidates = estimatedSearchPages * listingsPerPage;

  return {
    terms,
    pagesPerTerm,
    estimatedSearchPages,
    estimatedListingCandidates,
    largeJob: terms.length > 100 || estimatedListingCandidates > 10000,
  };
}

export function createJob(input = {}) {
  const estimate = estimateJob(input);
  if (estimate.terms.length === 0) {
    throw new Error("At least one valid search term is required.");
  }

  const createdAt = new Date().toISOString();
  return {
    id: input.id || `job_${crypto.randomUUID?.() || Date.now()}`,
    status: "draft",
    mode: "batch",
    // "manual" (▶ Run all / a term's ▶) vs "auto" (interval auto-run). A manual run isn't
    // governed by the auto-run QUEUE_RUN cycle, so it advances via the keepalive even when
    // auto-run is on — otherwise it crawls at the auto interval. (audit deep-pass #13)
    source: input.source === "auto" ? "auto" : "manual",
    terms: estimate.terms,
    pagesPerTerm: estimate.pagesPerTerm,
    sort: input.sort || "most_relevant",
    createdAt,
    updatedAt: createdAt,
    stats: {
      discovered: 0,
      scraped: 0,
      failed: 0,
    },
    estimate,
  };
}

// Pick the job a manual Resume should relaunch: a live "running" job first,
// otherwise the most-recently-updated unfinished job. Never an "error" job — the
// circuit-breaker tripped that because Etsy was blocking, so relaunching would
// just re-hammer. "completed" jobs are done; paused/stopped/draft are fair game.
export function selectResumableJob(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  return (
    list.find((j) => j.status === "running") ||
    [...list]
      .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
      .find((j) => j.status !== "completed" && j.status !== "error") ||
    null
  );
}

// The most recent unfinished job that includes `term` — the candidate to resume
// when the user clicks a queued term to CONTINUE it (instead of starting fresh).
// "completed"/"error" jobs are done; anything else may have leftover work.
export function selectResumableJobForTerm(jobs, term) {
  const list = Array.isArray(jobs) ? jobs : [];
  return (
    list
      .filter((j) => Array.isArray(j.terms) && j.terms.includes(term))
      .filter((j) => j.status !== "completed" && j.status !== "error")
      .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))[0] || null
  );
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  const next = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(next, min), max);
}

