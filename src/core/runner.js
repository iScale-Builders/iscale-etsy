import { buildSearchUrl, normalizeEtsyListingUrl } from "./etsy-url.js";
import { sameCalendarDay } from "./dedupe.js";
import { hashText } from "./hash.js";

// Which queued terms still need scraping TODAY, in queue (creation) order. A term
// gets a `lastDoneAt` stamp when its scrape fully completes; auto-run uses this so
// it (a) skips terms already finished today instead of looping back and re-searching
// them, and (b) naturally moves on to a term added mid-run (no stamp → eligible).
// Everything becomes eligible again the next calendar day (the daily refresh).
export function eligibleTerms(termRows = [], nowMs = Date.now()) {
  return (Array.isArray(termRows) ? termRows : [])
    .filter((t) => t && t.term && !sameCalendarDay(t.lastDoneAt, nowMs))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .map((t) => t.term);
}

// When auto-run has no NEW work left, pick the FAILED URLs still under the retry cap so
// they get re-visited instead of the runner idling — plus the set of terms they belong to
// (to launch the run). `autoRetries` counts ONLY auto-retries (manual Retry is unlimited
// and doesn't touch it), so a permanently-broken listing is left alone after `cap` attempts.
// cap<=0 disables it. (auto-retry-failed-when-idle)
export function failedToAutoRetry(rows = [], cap = 0) {
  if (!(cap > 0)) return { urls: [], terms: [] };
  const urls = [];
  const terms = new Set();
  for (const u of Array.isArray(rows) ? rows : []) {
    if (!u || u.status !== "failed") continue;
    if ((Number(u.autoRetries) || 0) >= cap) continue;
    urls.push(u);
    const ts = u.terms?.length ? u.terms : [u.searchTerm || u.term || ""];
    for (const t of ts) if (t) terms.add(t);
  }
  return { urls, terms: [...terms] };
}

export const RUNNER_DEFAULTS = {
  searchPageDelayMinMs: 1500,
  searchPageDelayMaxMs: 3000,
  navigationTimeoutMinMs: 25000,
  navigationTimeoutMaxMs: 35000,
};

// Pure alarm plan used by the MV3 service-worker shell. A persisted Chrome alarm
// is the durable countdown; startup must not throw away elapsed time by replacing
// it. Settings changes and completed ticks intentionally request a replacement.
export function queueAlarmDecision({ intervalMinutes = 0, preserveExisting = false, existingAlarm = null } = {}) {
  if (!(Number(intervalMinutes) > 0)) return "clear";
  if (preserveExisting && existingAlarm?.scheduledTime) return "preserve";
  return "replace";
}

// Chrome 120+ alarms have a 30-second floor. Schedule a term-boundary wake as
// close to its durable deadline as Chrome permits instead of waiting for the next
// full per-listing interval.
export function termGapAlarmDelayMinutes(gapUntil, nowMs = Date.now()) {
  const remainingMs = Math.max(0, Number(gapUntil) - Number(nowMs));
  return Math.max(0.5, remainingMs / 60000);
}

const TERMINAL_QUEUE_STATUSES = new Set(["done", "failed", "removed"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "error"]);

export function shouldPruneQueueRow(row, cutoffMs) {
  if (!row || !TERMINAL_QUEUE_STATUSES.has(row.status)) return false;
  const timestamp = Date.parse(row.removedAt || row.updatedAt || row.firstSeenAt || "");
  return Number.isFinite(timestamp) && timestamp < Number(cutoffMs);
}

export function shouldPruneJob(job, cutoffMs) {
  if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) return false;
  const timestamp = Date.parse(job.updatedAt || job.completedAt || job.createdAt || "");
  return Number.isFinite(timestamp) && timestamp < Number(cutoffMs);
}

export function makeListingQueueItems(urls, job, term, page) {
  const seen = new Set();
  return (Array.isArray(urls) ? urls : [])
    .map(normalizeEtsyListingUrl)
    .filter(Boolean)
    .filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .map((url) => ({
      id: `url_${job.id}_${hashText(url)}`,
      jobId: job.id,
      url,
      status: "pending",
      source: "batch",
      searchTerm: term,
      page,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
}

// THE continue-vs-fresh decision for one term (the runner's most-regressed
// logic — keep it here, pure and tested; do NOT re-derive it inline). Returns
// true to CONTINUE: reuse the term's already-walked search pages (skip them, just
// visit the URLs already in the queue) and discover only un-walked pages. Returns
// false to re-discover FRESH (re-walk every page).
//
// Continue when there is leftover work — pending URLs to visit OR pages not yet
// walked. A fully-walked term with NOTHING pending (done, or its URLs cleared)
// must re-discover fresh, otherwise the run skips discovery AND finds nothing to
// visit → an instant no-op "Batch Complete". Case matrix (pagesPerTerm = P):
//   walked 0,  pending no  → true  (nothing walked; "continue" seeds nothing = fresh)
//   walked <P, pending no  → true  (partial discovery — finish the un-walked pages)
//   walked =P, pending no  → FALSE (fully done → re-discover fresh, never a no-op)
//   walked =P, pending yes → true  (discovered, not visited → just visit them)
//   walked <P, pending yes → true  (continue: finish discovery + visit)
export function shouldContinueTerm({ walkedCount = 0, hasPending = false, pagesPerTerm = 0 } = {}) {
  return hasPending || walkedCount < pagesPerTerm;
}

// Should the auto-run alarm start a NEW term's cycle right now? ONLY when no job is
// still in flight. A job interrupted by a service-worker death stays `"running"` in
// the DB (its in-memory loop is gone, but its status was never set to "completed"),
// and a user-paused job is `"paused"`. Starting a new term while either exists is the
// constant term-switching bug: the alarm grabs a different term instead of letting
// the current one finish. Pure + tested so this decision can't silently regress.
export function shouldStartNewCycle(jobs = []) {
  return !jobs.some((j) => j && (j.status === "running" || j.status === "paused"));
}

// Post-block cooldown derived from the DURABLE error job, not a separate settings write.
// When the circuit breaker trips it writes the job to status "error" /
// reason "too_many_consecutive_failures" in one transaction; this reads that job's
// timestamp so the cooldown survives an MV3 eviction that could lose a separate
// settings.blockedUntil write. True while such an error job is younger than cooldownMs —
// auto-run must NOT start a new cycle (it would re-hammer a still-blocking Etsy). (audit deep-pass High #8)
export function recentBlockError(jobs = [], cooldownMs = 0, nowMs = Date.now()) {
  if (!(cooldownMs > 0)) return false;
  return (Array.isArray(jobs) ? jobs : []).some((j) => {
    if (!j || j.status !== "error" || j.reason !== "too_many_consecutive_failures") return false;
    const t = Date.parse(j.updatedAt || j.completedAt || "");
    return Number.isFinite(t) && nowMs - t < cooldownMs;
  });
}

// BETWEEN-TERMS pause decision (pure, tested). Called right before the runner would
// visit the first listing of `nextTerm`. Returns whether to PAUSE this tick and any
// durable cursor updates to persist. Completely independent of the per-listing timer.
//
//   betweenMs <= 0           → feature off; never pauses (zero behavior change)
//   nextType === "done"      → run finishing; no pause
//   no currentTerm yet       → first term of the run; just record it, no pause
//   nextTerm === currentTerm → still on the same term; no pause
//   nextTerm !== currentTerm → a real term→term transition:
//       no termGapUntil yet    → start the gap (pause), persist its end time
//       now < termGapUntil     → gap still running (pause)
//       now >= termGapUntil    → gap elapsed; enter the new term, clear the gap
//
// `setCurrentTerm`/`setGapUntil` are present in the result only when they should be
// written (so the caller does a single targeted putRecord). A finite `termGapUntil`
// (now + betweenMs) guarantees the pause can never get stuck.
export function betweenTermsGate({ betweenMs = 0, nextType = "done", nextTerm = "", currentTerm = "", termGapUntil = 0, nowMs = 0 } = {}) {
  if (betweenMs <= 0 || nextType === "done") return { gated: false };
  if (!currentTerm) return { gated: false, setCurrentTerm: nextTerm }; // first term — no pause
  if (nextTerm === currentTerm) return { gated: false }; // same term in progress
  if (!termGapUntil) return { gated: true, setGapUntil: nowMs + betweenMs }; // start the pause
  if (nowMs < termGapUntil) return { gated: true }; // still pausing
  return { gated: false, setCurrentTerm: nextTerm, setGapUntil: 0 }; // pause done → next term
}

// Ordered plan that drives a batch run: for each term, one "search" step per
// page followed by a single "visit" step. Consuming this in order is what makes
// every term finish (search + visit) before the next term begins — keep that
// invariant; the runner relies on it instead of two global discover/visit
// phases.
export function planJobSteps(job) {
  const sort = job.sort || "most_relevant";
  const steps = [];
  for (const term of job.terms || []) {
    for (let page = 1; page <= job.pagesPerTerm; page++) {
      steps.push({ type: "search", term, page, url: buildSearchUrl(term, page, sort) });
    }
    steps.push({ type: "visit", term });
  }
  return steps;
}

export function getJobSearchUrls(job) {
  return planJobSteps(job)
    .filter((step) => step.type === "search")
    .map(({ term, page, url }) => ({ term, page, url }));
}

