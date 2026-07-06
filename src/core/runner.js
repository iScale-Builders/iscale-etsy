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

// ⚠️ NOT WIRED INTO THE LIVE RUNNER. `background.js`'s runJob drives the run with
// `planJobSteps` + inline searchDone bookkeeping — it does NOT call
// nextRunnerStep/planTick. These two functions are a RESERVED durable-cursor engine
// kept for a planned user-initiated term-switching feature; wiring them in is a
// high-risk runner rewrite to be done only as a deliberate, live-verified effort.
// Their unit tests exercise THIS engine, not the shipping runner — don't read green
// here as coverage of production.
//
// THE runner's durable-cursor decision (pure, tested) — the brain of the
// alarm-driven driver. Given the current job's terms in order and what's already
// been walked (searchDone) / queued (pending listing URLs), return the SINGLE next
// action to take. No I/O, no Chrome, no in-memory loop — so a worker death just
// means the next alarm re-derives this from the DB and continues from exactly here.
// This is what structurally kills the round-robin: advancement is a function of
// durable state, not of which alarm happened to fire.
//
// Per term, in order (skipping cancelled terms): walk any un-walked search page
// (discover), then visit any pending listing (visit). A term is finished when every
// page 1..pagesPerTerm is walked AND it has no pending listings. When every term is
// finished, the run is done.
//
//   { type: "discover", term, page }  — walk this term's lowest un-walked page
//   { type: "visit", term }           — visit this term's next pending listing
//   { type: "done" }                  — no work left; the run is complete
export function nextRunnerStep({ terms = [], pagesPerTerm = 0, walkedByTerm = {}, pendingByTerm = {}, cancelled = [] } = {}) {
  const isCancelled = (t) => (Array.isArray(cancelled) ? cancelled.includes(t) : Boolean(cancelled?.has?.(t)));
  for (const term of terms) {
    if (isCancelled(term)) continue;
    const walked = walkedByTerm[term];
    const walkedSet = walked instanceof Set ? walked : new Set(Array.isArray(walked) ? walked : []);
    for (let page = 1; page <= pagesPerTerm; page++) {
      if (!walkedSet.has(page)) return { type: "discover", term, page }; // lowest un-walked page (robust to gaps)
    }
    if (Number(pendingByTerm[term] || 0) > 0) return { type: "visit", term };
  }
  return { type: "done" };
}

// THE pure brain of the alarm-driven engine. Given ONLY durable state — the running
// job (its terms, pagesPerTerm, searchDone) and the current `listing_urls` rows —
// return the single next action to take this tick. No I/O, no Chrome, no in-memory
// flags: the entire "where are we / what's next" decision is derived from the DB and
// is fully unit-testable. The runner shell just executes whatever this returns, then
// re-arms one alarm. A worker death between ticks is irrelevant — the next tick
// re-derives from the same durable state and continues.
//
//   { type: "discover", term, page }  — walk this term's next un-walked search page
//   { type: "visit", term }           — visit this term's next pending listing
//   { type: "done" }                  — nothing left; the run is complete
export function planTick({ job, urlRows = [], cancelled = [] } = {}) {
  if (!job || !Array.isArray(job.terms) || job.terms.length === 0) return { type: "done" };
  // Walked search pages per term, parsed from searchDone ("term|page" keys).
  const walkedByTerm = {};
  for (const key of job.searchDone || []) {
    const i = String(key).indexOf("|");
    if (i < 0) continue;
    const term = key.slice(0, i);
    const page = Number(key.slice(i + 1));
    if (!Number.isFinite(page)) continue;
    (walkedByTerm[term] ||= new Set()).add(page);
  }
  // Count of still-pending listings per term (a URL can belong to several terms).
  const pendingByTerm = {};
  for (const u of Array.isArray(urlRows) ? urlRows : []) {
    if (!u || u.status !== "pending") continue;
    const terms = u.terms?.length ? u.terms : [u.searchTerm, u.term].filter(Boolean);
    for (const t of terms) pendingByTerm[t] = (pendingByTerm[t] || 0) + 1;
  }
  return nextRunnerStep({ terms: job.terms, pagesPerTerm: job.pagesPerTerm || 0, walkedByTerm, pendingByTerm, cancelled });
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

