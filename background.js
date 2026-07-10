import { dispatchAction } from "./src/core/actions.js";
import { recordScrape, sameCalendarDay } from "./src/core/dedupe.js";
import { betweenTermsGate, eligibleTerms, failedToAutoRetry, makeListingQueueItems, planJobSteps, queueAlarmDecision, recentBlockError, RUNNER_DEFAULTS, shouldContinueTerm, shouldPruneJob, shouldPruneQueueRow, shouldStartNewCycle, termGapAlarmDelayMinutes } from "./src/core/runner.js";
import { createJob, selectResumableJob } from "./src/core/jobs.js";
import { parseSearchTerms, extractListingId } from "./src/core/etsy-url.js";
import { urlQueueId, mergeQueueDiscovery, addTermToRow, collapseQueueRows, isLegacyQueueRow } from "./src/core/url-queue.js";
import { buildQueueView } from "./src/core/queue-view.js";
import { withListingsLock } from "./src/core/locks.js";
import { getAllRecords, getAllByIndex, getRecord, putRecord, bulkPut, bulkDelete, countRecords, deleteRecord, clearStore, reduceRecords } from "./src/core/storage.js";
import { rowsToCsv, csvHeaderLine, csvRowLine, makeExportFilename, withSubfolder } from "./src/core/csv.js";
import { DEFAULT_SETTINGS, feedItem, formatBadgeCount, shouldAutoExport, jitteredAutoRunMinutes, jitteredBetweenTermsMs, blockCooldownMs, inBlockCooldown } from "./src/core/collection.js";
import { mergeSearchResult, searchResultKey, SEARCH_EXPORT_COLUMNS } from "./src/core/search-results.js";
import { aggregateSession, blankSessionTally, foldSessionUrl } from "./src/core/session.js";
import { createKeyedQueue } from "./src/core/serialize.js";
import { authorizeMessageSender } from "./src/core/message-auth.js";

const state = {
  activeJobId: null,
  running: false,
  paused: false,
  stopRequested: false,
  tabId: null,
  lastJobProgress: null,
  listingCount: 0, // maintained in-memory so saves don't rescan the whole store
  withDemandCount: 0, // listings with demand data — maintained in-memory alongside listingCount
  settings: null, // cached settings (single writer = this SW)
  loopAlive: false, // true while the runJob loop is actually executing
  launching: false, // true between claiming the runner slot and launchJob setting loopAlive
  cancelledTerms: new Set(), // terms removed mid-run — the runner skips their remaining work
};

// Synchronously claim the single runner slot before any `await`. Two async entry
// points (onStartup's resume + the keep-alive alarm, or a manual start racing a
// resume) used to both pass a `loopAlive` check while it was still false, then
// both call launchJob -> two runJob loops driving the same tab (double-save,
// racing writes). loopAlive only flips inside launchJob, after awaits; this latch
// flips synchronously so the second caller bails. Release in a finally; launchJob
// sets loopAlive synchronously, so the slot stays held continuously once a loop
// actually starts.
function claimRunner() {
  if (state.loopAlive || state.launching) return false;
  state.launching = true;
  // Clear stop/pause intent synchronously at claim time (NOT in launchJob). A genuine
  // Stop/Pause arriving DURING the claim→launch awaits then re-sets the flag, and
  // launchJob honors it instead of starting the loop. (audit deep-pass #1)
  state.stopRequested = false;
  state.paused = false;
  return true;
}

const SETTINGS_ID = "app";

async function getSettings() {
  if (state.settings) return state.settings;
  const record = await getRecord("settings", SETTINGS_ID);
  state.settings = { ...DEFAULT_SETTINGS, ...(record?.value || {}) };
  return state.settings;
}

const settingsQueue = createKeyedQueue();
// Serialize all settings writes so two concurrent handlers (e.g. dashboard + shop view, or
// a save racing the runner's blockedUntil/lastExportTotal write) can't each read the same
// cached snapshot, merge their own field, and have the second put clobber the first's.
// (audit deep-pass Low — concurrent saveSettings lost-update)
function saveSettings(value) {
  return settingsQueue("settings", async () => {
    const next = { ...(await getSettings()), ...value };
    await putRecord("settings", { id: SETTINGS_ID, value: next });
    state.settings = next;
    if (
      Object.prototype.hasOwnProperty.call(value, "searchIntervalMin") ||
      Object.prototype.hasOwnProperty.call(value, "autoRunEnabled") ||
      Object.prototype.hasOwnProperty.call(value, "randomizeInterval") ||
      Object.prototype.hasOwnProperty.call(value, "randomizePct")
    ) {
      await scheduleQueueRun(next);
    }
    return next;
  });
}

// The toolbar icon ALWAYS opens the popup. The side panel is an opt-in surface
// that pages open on demand via chrome.sidePanel.open() — it never replaces the
// popup. This just guarantees the default click behavior on startup.
async function ensurePopupDefault() {
  try {
    await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false });
    await chrome.sidePanel?.setOptions?.({ path: "dashboard.html?ctx=side", enabled: true });
    await chrome.action.setPopup({ popup: "dashboard.html" });
  } catch {
    // Side panel API unavailable — popup is already the manifest default.
  }
}

function broadcast(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // No receivers (no open extension pages) — ignore.
  }
}

async function setBadge(total) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#d6552b" });
    await chrome.action.setBadgeText({ text: formatBadgeCount(total) });
  } catch {
    // chrome.action unavailable in some contexts — ignore.
  }
}

async function refreshBadge() {
  // One cursor pass seeds BOTH live counters from the store, so "collected" and
  // "with demand" always start consistent (withDemand ≤ total) and stay O(1) per save.
  const tally = await reduceRecords(
    "listings",
    (acc, row) => ({
      total: acc.total + 1,
      withDemand: acc.withDemand + (row.demandValue > 0 || row.demandText ? 1 : 0),
    }),
    { total: 0, withDemand: 0 },
  );
  state.listingCount = tally.total;
  state.withDemandCount = tally.withDemand;
  await setBadge(state.listingCount);
}

async function initFromSettings() {
  await refreshBadge();
  await ensurePopupDefault();
  await migrateQueueToUrlKeyed();
  await cleanOrphanQueue();
  await resetOrphanProcessing();
  await pruneHistory();
  const settings = await getSettings();
  // Chrome alarms survive MV3 worker eviction. Preserve an existing countdown
  // instead of resetting it to a full fresh interval on every worker startup.
  await scheduleQueueRun(settings, { preserveExisting: true });
  // Guarded: if scheduleQueueRun armed the QUEUE_RUN countdown (auto-run on), let THAT
  // advance the run rather than firing an immediate extra scrape on every SW restart.
  // A manual/auto-off interrupted job (no pending alarm) still resumes right away. (HIGH-1)
  await guardedResume();
}

const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function pruneHistory(nowMs = Date.now()) {
  const cutoff = nowMs - HISTORY_RETENTION_MS;
  try {
    const [queueIds, jobIds] = await Promise.all([
      reduceRecords(
        "listing_urls",
        (ids, row) => {
          if (shouldPruneQueueRow(row, cutoff)) ids.push(row.id);
          return ids;
        },
        [],
      ),
      reduceRecords(
        "jobs",
        (ids, job) => {
          if (shouldPruneJob(job, cutoff)) ids.push(job.id);
          return ids;
        },
        [],
      ),
    ]);
    const [queueDeleted, jobsDeleted] = await Promise.all([
      bulkDelete("listing_urls", queueIds),
      bulkDelete("jobs", jobIds),
    ]);
    if (queueDeleted || jobsDeleted) {
      console.log(`[History] Pruned ${queueDeleted} terminal queue rows and ${jobsDeleted} terminal jobs older than 30 days.`);
    }
  } catch (error) {
    console.warn("[History] retention cleanup failed:", error);
  }
}

// Drop pending/failed queue rows whose term is no longer an actual QUEUED PILL
// (search_terms). Leftover/stuck JOBS don't count — keying off them is what let a
// removed term's URLs sit forever as a stuck "term (N)" tab. A running run's terms
// are always in search_terms (addTerms persists them on start), so live runs are
// safe. Done (collected) rows and the `listings` collection are never touched; a
// wrongly-cleared URL just re-discovers on the next run. (bug, 2026-06-26)
async function cleanOrphanQueue() {
  try {
    const terms = await getAllRecords("search_terms");
    const live = new Set(terms.map((t) => t.term));
    const orphanIds = await reduceRecords(
      "listing_urls",
      (ids, row) => {
        // Clear ALL rows (incl. done) whose term isn't a queued pill — so the queue
        // only ever holds rows for current terms. Accumulate ids, not full rows.
        const rowTerms = [...(row.terms || []), row.searchTerm, row.term].filter(Boolean);
        if (!rowTerms.some((term) => live.has(term))) ids.push(row.id);
        return ids;
      },
      [],
    );
    const removed = await bulkDelete("listing_urls", orphanIds);
    if (removed) console.log(`[Queue] Cleaned ${removed} orphaned pending URLs (their terms aren't queued).`);
  } catch (error) {
    console.warn("[Queue] orphan cleanup failed:", error);
  }
}

// Reset orphaned "processing" rows back to "pending". A row is flipped to
// `processing` BEFORE its listing is visited (background.js ~487); if the MV3
// worker is suspended mid-visit it never advances to done/failed and sticks as a
// ghost "scraping…" row forever. This runs at init, when NO run is alive — so
// every `processing` row is such a ghost. Resetting it lets the interrupted
// listing re-visit AND keeps the UI showing exactly ONE active row at a time.
// Does NOT touch the runner loop. (bug, 2026-06-26)
async function resetOrphanProcessing(olderThan) {
  try {
    const now = new Date().toISOString();
    const rows = await reduceRecords(
      "listing_urls",
      (out, row) => {
        if (row.status !== "processing") return out;
        // When a cutoff is supplied (per-run heal), only reset rows last touched
        // BEFORE this run started — i.e. genuine ghosts from a prior run / SW death.
        if (olderThan && row.updatedAt && row.updatedAt >= olderThan) return out;
        out.push({ ...row, status: "pending", updatedAt: now });
        return out;
      },
      [],
    );
    const reset = await bulkPut("listing_urls", rows);
    if (reset) console.log(`[Queue] Reset ${reset} orphaned processing rows → pending.`);
  } catch (error) {
    console.warn("[Queue] processing reset failed:", error);
  }
}

// One-time, idempotent migration: collapse the legacy per-(job,URL) `listing_urls`
// rows into one canonical row per URL (the URL-keyed queue). Only legacy `url_…`
// rows are touched; runs harmlessly (no-op) once they're gone. Never touches the
// `listings` collection. (Stage 2 of the queue refactor, 2026-06-26)
async function migrateQueueToUrlKeyed() {
  try {
    const rows = await getAllRecords("listing_urls");
    const legacy = rows.filter(isLegacyQueueRow);
    if (legacy.length === 0) return;
    const existingCanonical = new Set(rows.filter((r) => !isLegacyQueueRow(r)).map((r) => r.id));
    const collapsed = collapseQueueRows(legacy, new Date().toISOString()).filter((r) => !existingCanonical.has(r.id));
    await bulkPut("listing_urls", collapsed);
    for (const r of legacy) await deleteRecord("listing_urls", r.id);
    console.log(`[Queue] Migrated ${legacy.length} legacy rows → ${collapsed.length} URL-keyed rows.`);
  } catch (error) {
    console.warn("[Queue] URL-keyed migration failed (will retry next start):", error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initFromSettings();
});

chrome.runtime.onStartup?.addListener(() => initFromSettings());
initFromSettings();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const authorization = authorizeMessageSender({
    action: message?.action,
    sender,
    extensionId: chrome.runtime.id,
    extensionOrigin: chrome.runtime.getURL(""),
  });
  if (!authorization.allowed) {
    sendResponse({ ok: false, error: authorization.reason });
    return false;
  }
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message, sender) {
  if (!message || typeof message.action !== "string") {
    throw new Error("Missing action.");
  }

  // While a scrape is RUNNING, the runner's background tab (state.tabId) drives
  // its own captures directly (saveSearchResults / listing.extract). That tab's
  // content scripts ALSO fire their passive auto-capture, which would save+
  // broadcast the same page a second time (the passive 1.8s timer beats the
  // runner's scroll+extract). Ignore passive captures from the runner tab — but
  // ONLY during an active scrape, so manual browsing (even in that reused tab
  // between runs) still feeds the live feed normally.
  const scrapeActive = state.loopAlive || state.launching;
  const fromRunnerTab = scrapeActive && sender?.tab?.id != null && sender.tab.id === state.tabId;

  if (message.action === "listing.savePassive") {
    if (fromRunnerTab) return { saved: false, skipped: "runner_tab" };
    const listing = message.input?.listing;
    if (!listing?.id) throw new Error("Missing listing payload.");
    // A manual listing-page visit is a real visit too — stamp lastVisitedAt.
    await saveListing({ ...listing, lastVisitedAt: new Date().toISOString() });
    return { saved: true, listingId: listing.listingId };
  }

  if (message.action === "search.saveResults") {
    if (fromRunnerTab) return { saved: 0, skipped: "runner_tab" };
    return saveSearchResults(message.input?.payload, { captureListings: message.input?.fromManualBrowse === true });
  }

  // Clear the accumulated research collection (the `listings` store) and reset the
  // count, badge, and the auto-export watermark. Does NOT touch the queue or terms.
  if (message.action === "collection.clear") {
    // Reset the auto-export watermark BEFORE wiping the store, so an eviction between can't
    // leave listings cleared with a stale (high) watermark that suppresses auto-export.
    // (audit deep-pass Low)
    await saveSettings({ lastExportTotal: 0 });
    await withListingsLock("exclusive", () => clearStore("listings")); // exclude concurrent saves (deep-pass Med)
    state.listingCount = 0;
    state.withDemandCount = 0;
    await setBadge(0);
    broadcast({ action: "collection.update", total: 0, withDemand: 0 });
    return { cleared: true };
  }

  // Re-seed the in-memory counters from the store after a writer that bypassed the SW
  // (e.g. the Shop View CSV import writes `listings` directly). Without this the badge
  // and the dashboard "X collected" stay stale until the next SW restart, and the next
  // passive save computes its total off a wrong base.
  if (message.action === "collection.refresh") {
    await refreshBadge();
    broadcast({ action: "collection.update", total: state.listingCount, withDemand: state.withDemandCount });
    return { total: state.listingCount, withDemand: state.withDemandCount };
  }

  return dispatchAction(message.action, message.input || {}, {
    saveJob: async (job) => {
      await putRecord("jobs", job);
      return job;
    },
    listJobs: () => getAllRecords("jobs"),
    getJobStatus: async (id) => {
      // Polled by the dashboard every ~2.5s — use the O(1) keyed get. (audit LOW perf)
      const job = (await getRecord("jobs", id)) || null;
      return { job, state };
    },
    startJob: async (id) => {
      if (!claimRunner()) return { started: false, reason: "already_running" };
      try {
        const job = await getRecord("jobs", id);
        if (!job) return { started: false, reason: "job_not_found" };
        const updated = { ...job, status: "running", updatedAt: new Date().toISOString() };
        await putRecord("jobs", updated);
        launchJob(updated);
        return { started: true, job: updated };
      } finally {
        state.launching = false;
      }
    },
    resumeJob: () => resumeJob(),
    setRunnerState: async (nextState) => {
      Object.assign(state, nextState);
      // Set the stop intent synchronously (before any await) so a keep-alive alarm
      // firing during the writes below sees it and bails instead of resurrecting
      // the job. (audit M-2)
      if (nextState.running === false) state.stopRequested = true;
      // Resolve the target job from DURABLE truth (the running/paused row), NOT the
      // volatile state.activeJobId. activeJobId is only set in launchJob, so a Stop in the
      // pre-launch window would otherwise skip the durable write and leave a "running" row
      // that auto-resumes (deep-pass #2); a STALE activeJobId would also rewrite a finished
      // job to "stopped" and make it the wrong resume candidate (deep-pass #4). Only an
      // actually-in-flight job is touched. updateJob serializes the write (#3).
      const inFlight = (await getAllRecords("jobs")).find((j) => j && (j.status === "running" || j.status === "paused"));
      if (inFlight) {
        const status = state.running ? (state.paused ? "paused" : "running") : "stopped";
        await updateJob(inFlight.id, (job) => ({ ...job, status, updatedAt: new Date().toISOString() }));
      }
      // Stop the keep-alive alarm after the durable "stopped" write — otherwise it
      // keeps waking the SW every 30s until the loop reaches a checkpoint.
      if (nextState.running === false) await stopKeepAlive();
      return { state };
    },
    getListings: async (filter = {}) => {
      const listings = await getAllRecords("listings");
      return filterListings(listings, filter);
    },
    openShop: () => chrome.tabs.create({ url: chrome.runtime.getURL("shop.html") }),
    getSettings: () => getSettings(),
    saveSettings: (value) => saveSettings(value || {}),
    listTerms: () => listTerms(),
    addTerms: (terms) => addTerms(terms),
    removeTerm: (id) => removeTerm(id),
    clearTerms: () => clearTerms(),
    runTerms: (terms, pagesPerTerm) => runTerms(terms, pagesPerTerm),
    continueTerm: (term, pagesPerTerm) => continueOrRunTerm(term, pagesPerTerm),
    // Pure view-building (term grouping, active-term done-surfacing, counts, CAP, failed
    // block) lives in buildQueueView — unit-tested. Here we just feed it the rows. (M-14)
    pendingUrls: async () => buildQueueView(await getAllRecords("listing_urls")),
    retryFailed: (term, pagesPerTerm) => retryFailedTerm(term, pagesPerTerm),
    removeUrl: (url, term) => removeQueuedUrl(url, term),
    nextRun: async () => {
      // When the next auto-run cycle is scheduled (ms epoch), for the dashboard
      // countdown. 0 when auto-run is off / no alarm.
      try {
        const alarm = await chrome.alarms.get(QUEUE_RUN_ALARM);
        return { at: alarm?.scheduledTime || 0 };
      } catch {
        return { at: 0 };
      }
    },
    sessionStatus: async () => {
      // listing_urls is unbounded and this runs on a 4s poll while a job is
      // live — fold it in a single cursor pass (foldSessionUrl) instead of
      // materializing every row. Same pattern as collectionStats below.
      const [terms, urlTally, jobs, searchResultsTotal] = await Promise.all([
        getAllRecords("search_terms"),
        reduceRecords("listing_urls", foldSessionUrl, blankSessionTally()),
        getAllRecords("jobs"),
        countRecords("search_results"),
      ]);
      return aggregateSession({ terms, urlTally, jobs, listingsTotal: state.listingCount, searchResultsTotal });
    },
    collectionStats: async () => {
      // Runs on panel open (not per-save). search_results counted O(1); listings
      // are folded in a single cursor pass so we never hold ~180k rows in memory
      // just to derive digital/withDemand counts.
      const [tally, searchResults] = await Promise.all([
        reduceRecords(
          "listings",
          (acc, row) => ({
            total: acc.total + 1,
            digital: acc.digital + (row.isDigital === true ? 1 : 0),
            withDemand: acc.withDemand + (row.demandValue > 0 || row.demandText ? 1 : 0),
          }),
          { total: 0, digital: 0, withDemand: 0 },
        ),
        countRecords("search_results"),
      ]);
      return {
        total: tally.total,
        digital: tally.digital,
        withDemand: tally.withDemand,
        searchResults,
        jobProgress: state.lastJobProgress,
        settings: await getSettings(),
      };
    },
    exportSearchCsv: async () => {
      const rows = await getAllRecords("search_results");
      const csv = rowsToCsv(rows, SEARCH_EXPORT_COLUMNS);
      await downloadCsv(makeExportFilename("etsy-search-results"), csv, true);
      return { rows: rows.length };
    },
    downloadImage: async (url, title) => {
      // The url comes from scraped/imported data — only allow https images on
      // Etsy / its CDN before handing it to chrome.downloads (confused-deputy guard).
      let u;
      try {
        u = new URL(String(url || ""));
      } catch {
        return { ok: false, reason: "bad_url" };
      }
      const okHost = /(^|\.)etsy\.com$/i.test(u.hostname) || /(^|\.)etsystatic\.com$/i.test(u.hostname);
      if (u.protocol !== "https:" || !okHost) return { ok: false, reason: "blocked_host" };
      const extMatch = u.href.match(/\.(jpe?g|png|webp|gif)(?:[?#]|$)/i);
      const ext = (extMatch ? extMatch[1] : "jpg").toLowerCase();
      const name = `${String(title || "product").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "product"}.${ext}`;
      await chrome.downloads.download({ url: u.href, filename: name, saveAs: false });
      return { ok: true };
    },
    downloadText: async (filename, text, mimeType) => {
      // MV3 service workers have no URL.createObjectURL — use a data: URL so the
      // download works instead of throwing. saveAs:false → goes straight into the
      // Downloads folder (or the Save-to-subfolder) with no "save as" dialog.
      // Whitelist the MIME type (only ever text/csv or text/plain here) so a caller
      // can't smuggle an arbitrary scheme into the data: URL. Filename is sanitized by
      // withSubfolder (sanitizeFilename) below.
      const safeMime = mimeType === "text/csv" ? "text/csv" : "text/plain";
      const url = `data:${safeMime};charset=utf-8,${encodeURIComponent(text)}`;
      const settings = await getSettings();
      await chrome.downloads.download({ url, filename: withSubfolder(filename, settings.downloadSubfolder), saveAs: false });
    },
  });
}

const JOB_KEEPALIVE_ALARM = "etsy-job-keepalive";
const TERM_GAP_ALARM = "etsy-term-gap";
const MAX_CONSECUTIVE_FAILURES = 8;

// The ONE entry point that runs a job loop. Owns the running/loopAlive flags so
// callers (start / resume / interrupted-resume / queue) can't create a zombie
// "running" job with no live loop. Fire-and-forget (don't await it).
function launchJob(job) {
  // A Stop/Pause that landed during the claim→launch awaits wins: claimRunner cleared the
  // intent, so a truthy flag now is a genuine new request. Don't start the loop — the
  // durable status is written by setRunnerState (resolved from DB truth). The caller's
  // finally clears state.launching, releasing the slot. (audit deep-pass #1)
  if (state.stopRequested || state.paused) return;
  state.activeJobId = job.id;
  state.running = true;
  state.loopAlive = true;
  runJob(job)
    .catch(async (error) => {
      await updateJob(job.id, (j) => ({ ...j, status: "error", error: error.message, updatedAt: new Date().toISOString() }));
      await stopKeepAlive();
    })
    .finally(() => {
      state.running = false;
      state.loopAlive = false;
    });
}

// Resume: if the loop is genuinely alive (paused), just un-pause. Otherwise the
// loop is gone (Stop, or a service-worker restart) — re-launch the most recent
// unfinished job from its durable queue so it actually continues.
async function resumeJob() {
  // Fast-path only when the loop is genuinely alive AND no Stop is settling. Clearing
  // stopRequested before this check (the old code) let a Stop-then-Run-all within the
  // visit window resurrect a loop against an already-"stopped" row. With a settling stop,
  // fall through: claimRunner returns false (loop still alive) → "already_running", no
  // resurrection. claimRunner clears stop/pause intent on a genuine relaunch. (deep-pass #5)
  if (state.loopAlive && !state.stopRequested) {
    state.paused = false;
    state.running = true;
    return { resumed: true, mode: "unpaused" };
  }
  if (!claimRunner()) return { resumed: false, reason: "already_running" };
  try {
    const jobs = await getAllRecords("jobs");
    const job = selectResumableJob(jobs);
    if (!job) return { resumed: false, reason: "no_job" };
    // URL-keyed queue is global — reset every mid-visit (processing) row to pending.
    await resetOrphanProcessing();
    launchJob(job);
    return { resumed: true, mode: "relaunched", jobId: job.id };
  } finally {
    state.launching = false;
  }
}

async function runJob(job) {
  const runStartedAt = new Date().toISOString();
  const startedJob = { ...job, status: "running", startedAt: job.startedAt || runStartedAt, searchDone: job.searchDone || [] };
  await putRecord("jobs", startedJob);
  await startKeepAlive();
  // Heal any rows left "processing" by a prior interrupted run: nothing is being
  // visited yet in THIS service-worker instance, so anything last touched before
  // this instance started is a stale ghost. Passing runStartedAt as the cutoff
  // resets only those — never a row a (current or future) in-flight run owns —
  // so the visit step retries ghosts instead of skipping them forever and they
  // don't show as phantom scrapes.
  await resetOrphanProcessing(runStartedAt);
  const settings = await getSettings(); // BETWEEN-LISTINGS hold value (re-read per run)
  const tab = await getOrCreateRunnerTab();

  const searchDone = new Set(startedJob.searchDone);
  const progress = { running: true, phase: "starting", term: "", page: 0, currentUrl: "", discovered: 0, queue: 0, scraped: 0, failed: 0 };
  // Restore the breaker count from the job row so a resume after a SW kill mid-
  // blocking-episode doesn't reset to 0 and re-hammer Etsy for another full run.
  let consecutiveFailures = job.consecutiveFailures || 0;
  let aborted = false;
  const emit = (extra = {}) => {
    Object.assign(progress, extra);
    state.lastJobProgress = { ...progress };
    broadcast({ action: "job.progress", progress: state.lastJobProgress });
  };
  emit();

  // Visit one listing URL; returns false if the job hit the failure circuit-breaker.
  // `term` is the term being scraped right now (step.term) — NOT item.searchTerm,
  // which is the URL's FIRST-seen term and differs for every listing shared across
  // overlapping searches. Using item.searchTerm made the status flip term on nearly
  // every URL ("cycling through terms") even though one term was being scraped.
  const processItem = async (item, term) => {
    emit({ phase: "listing", term, currentUrl: item.url });
    // Once per calendar day: if this listing was already scraped today (e.g. the
    // URL was queued before today's scrape), skip the re-visit and mark it done.
    if (await scrapedToday(item.url, Date.now())) {
      await putRecord("listing_urls", { ...item, status: "done", reason: "already_scraped_today", updatedAt: new Date().toISOString() });
      progress.queue = Math.max(0, progress.queue - 1);
      emit({ phase: "listing" });
      return true;
    }
    await putRecord("listing_urls", { ...item, status: "processing", updatedAt: new Date().toISOString() });
    // A navigation timeout is often just a slow page, not a block. Retry once so a
    // transient slow load doesn't count toward the failure circuit-breaker; a real
    // block times out both times and still fails extraction below. (audit M-7)
    const nav = await navigateAndWait(tab.id, item.url);
    if (nav?.timedOut) await navigateAndWait(tab.id, item.url);
    // SHORT settle only — then extract IMMEDIATELY so the review check fires within a
    // few seconds of the page loading. The long anti-block hold is now BETWEEN
    // listings (see the visit loop), not before each review check.
    await delay(randomInRange(1500, 3500));
    const res = await sendTabMessage(tab.id, {
      action: "listing.extract",
      input: { source: "batch", searchTerm: term, jobId: startedJob.id },
    });
    if (res?.listing?.found !== false && res?.listing?.id) {
      // Stamp the real listing-page visit (drives the once-per-day guard).
      await saveListing({ ...res.listing, lastVisitedAt: new Date().toISOString() });
      await putRecord("listing_urls", { ...item, status: "done", updatedAt: new Date().toISOString() });
      progress.scraped += 1;
      consecutiveFailures = 0;
      await updateJobStats(startedJob.id, { scraped: 1 }, { consecutiveFailures });
    } else {
      await putRecord("listing_urls", {
        ...item,
        status: "failed",
        reason: res?.listing?.reason || res?.error || "extract_failed",
        updatedAt: new Date().toISOString(),
      });
      progress.failed += 1;
      consecutiveFailures += 1;
      await updateJobStats(startedJob.id, { failed: 1 }, { consecutiveFailures });
    }
    progress.queue = Math.max(0, progress.queue - 1);
    emit({ phase: "listing" });
    // Circuit-breaker: Etsy blocking/logged-out shouldn't burn the whole queue.
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      aborted = true;
      // PREVENTION (golden rule): stamp the durable post-block cooldown FIRST, so auto-run
      // won't immediately build a fresh cycle and re-hammer a still-blocking Etsy. (BLOCKER-1)
      // Written before the job→error flip so an eviction between the two can't drop it; and
      // even if it's lost, runQueuedTerms' recentBlockError derives the cooldown from the
      // durable error job below. (audit deep-pass High #8)
      await saveSettings({ blockedUntil: Date.now() + blockCooldownMs(settings) });
      // Persist the abort. If the SW dies before runJob's final write, the job must already
      // be "error" so the keep-alive resume won't relaunch it (resumeInterruptedJob only
      // matches "running") and re-hammer a block. This write is also the durable cooldown
      // stamp recentBlockError reads.
      await updateJob(startedJob.id, (j) => ({
        ...j,
        status: "error",
        reason: "too_many_consecutive_failures",
        consecutiveFailures,
        updatedAt: new Date().toISOString(),
      }));
      return false;
    }
    return true;
  };

  // Process each search term FULLY before moving to the next: discover that
  // term's search pages, then immediately visit every listing it surfaced,
  // then advance to the next term. (Previously this discovered every term's
  // URLs up front and only then visited them all.) searchDone (term|page keys)
  // still makes a resume after a service-worker kill skip pages already walked,
  // and listing_urls statuses make it skip listings already done/failed, so a
  // partly-finished term resumes mid-term without re-hammering Etsy.
  // Drive the run from the declarative, unit-tested step plan (planJobSteps):
  // each term's search pages, then a single visit step, so every term finishes
  // before the next begins. Resume safety is unchanged: searchDone (term|page)
  // skips walked pages and listing_urls statuses skip done/failed listings, so
  // a partly finished term resumes mid-term without re-hammering Etsy.
  // BETWEEN-TERMS pause (opt-in; betweenTermsSec) evaluated at the TRUE term boundary:
  // right before the FIRST actionable step of a new term, so the next term's searches
  // AND visits both wait. Default 0 leaves this inert — the per-listing cadence is
  // unchanged. Durable job fields (currentTerm/termGapUntil) make it survive a
  // worker death mid-pause; a dedicated one-shot alarm wakes at the deadline.
  // Returns true when it gated — the caller must yield (return) so the alarm re-checks
  // on the next tick. `currentTerm` is armed by whichever step type first does real work
  // for a term, so it never silently no-ops when a term has only searches or only visits.
  const applyBetweenTermsGate = async (stepType, stepTerm) => {
    // Jittered ±randomizePct (when randomize is on) so the term→term gap isn't robotic. The
    // value only matters on the FIRST gate hit (it sets the durable termGapUntil deadline);
    // later ticks read that deadline, so re-computing here is harmless. (between-terms randomizer)
    const betweenMs = jitteredBetweenTermsMs(settings);
    if (betweenMs <= 0) return false;
    const jobNow = await getRecord("jobs", startedJob.id);
    const gate = betweenTermsGate({
      betweenMs,
      nextType: stepType,
      nextTerm: stepTerm,
      currentTerm: jobNow?.currentTerm || "",
      termGapUntil: jobNow?.termGapUntil || 0,
      nowMs: Date.now(),
    });
    if ("setCurrentTerm" in gate || "setGapUntil" in gate) {
      await updateJob(startedJob.id, (job) => ({
        ...job,
        ...("setCurrentTerm" in gate ? { currentTerm: gate.setCurrentTerm } : {}),
        ...("setGapUntil" in gate ? { termGapUntil: gate.setGapUntil } : {}),
        updatedAt: new Date().toISOString(),
      }));
    }
    if (gate.gated) {
      const until = "setGapUntil" in gate && gate.setGapUntil ? gate.setGapUntil : jobNow?.termGapUntil || Date.now() + betweenMs;
      await scheduleTermGapResume(until);
      emit({ phase: "between-terms", term: stepTerm, gapUntil: until, currentUrl: "" });
    } else if ("setGapUntil" in gate && gate.setGapUntil === 0) {
      await chrome.alarms.clear(TERM_GAP_ALARM);
    }
    return gate.gated;
  };

  for (const step of planJobSteps(startedJob)) {
    if (shouldStop() || aborted) break;
    if (state.cancelledTerms.has(step.term)) continue; // pill removed mid-run — skip this term's work

    if (step.type === "search") {
      const key = `${step.term}|${step.page}`;
      if (searchDone.has(key)) continue; // already done on a previous (interrupted) run — skip (no gate)
      // First actionable step of this term → pause at the boundary before its searches start.
      if (await applyBetweenTermsGate("search", step.term)) {
        stopKeepAlivePing();
        return;
      }
      await waitWhilePaused();
      emit({ phase: "search", term: step.term, page: step.page, currentUrl: "" });
      await navigateAndWait(tab.id, step.url);
      await delay(randomInRange(300, 700)); // brief settle before scrolling
      const response = await sendTabMessage(tab.id, { action: "search.scrollAndExtract" });
      if (response?.payload) await saveSearchResults(response.payload);

      // URL-keyed queue: upsert one canonical row per URL, unioning the term that
      // surfaced it. Don't (re-)queue a URL being visited right now, or one already
      // fully scraped today (once-per-day) — just record the term association.
      const normUrls = makeListingQueueItems(response?.urls || [], startedJob, step.term, step.page).map((i) => i.url);
      let added = 0;
      const nowMs = Date.now();
      for (const url of normUrls) {
        const now = new Date().toISOString();
        const existing = await getRecord("listing_urls", urlQueueId(url));
        if (existing && existing.status === "removed") continue; // honor the user's deletion — never resurrect a tombstoned URL
        if (existing && existing.status === "processing") {
          const withTerm = addTermToRow(existing, step.term, now);
          if (withTerm !== existing) await putRecord("listing_urls", withTerm);
          continue;
        }
        if (await scrapedToday(url, nowMs)) {
          if (existing) await putRecord("listing_urls", addTermToRow({ ...existing, status: "done" }, step.term, now));
          continue;
        }
        const row = mergeQueueDiscovery(existing, { url, term: step.term, page: step.page, source: "batch" }, now);
        await putRecord("listing_urls", row);
        if (!existing || existing.status !== "pending") added += 1;
      }
      progress.discovered += added;
      progress.queue += added;
      await updateJobStats(startedJob.id, { discovered: added });
      searchDone.add(key);
      await persistSearchDone(startedJob.id, searchDone);
      emit({ phase: "search" });
      await delay(randomInRange(RUNNER_DEFAULTS.searchPageDelayMinMs, RUNNER_DEFAULTS.searchPageDelayMaxMs)); // pause between search pages
      continue;
    }

    // step.type === "visit": visit EXACTLY ONE listing per countdown tick, then YIELD
    // (return). The QUEUE_RUN alarm IS the countdown; when it next reaches 0 it resumes
    // this job and visits the next pending listing. So the visible countdown literally
    // fires each URL — one per tick — and only rolls to the next term once THIS term
    // has nothing pending left. (Was: drain the whole term in one wake with an in-loop
    // delay, which ran on a separate clock from the countdown.)
    // Visit in discovery order: page 1's listings first, then page 2, … (the index
    // returns hash order otherwise). Matches the remaining-URL list ordering.
    const pending = (await getAllByIndex("listing_urls", "terms", step.term))
      .filter((u) => u.status === "pending")
      .sort((a, b) => (Number(a.page) || 0) - (Number(b.page) || 0) || String(a.url).localeCompare(String(b.url)));
    if (!pending.length) continue; // this term is drained → next term's steps (or completion)
    if (shouldStop() || aborted || state.cancelledTerms.has(step.term)) break;
    // First actionable step of this term may be a visit (its searches were walked on a
    // prior run) — pause at the boundary before the first listing too.
    if (await applyBetweenTermsGate("visit", step.term)) {
      stopKeepAlivePing();
      return;
    }
    await waitWhilePaused();
    progress.queue = pending.length;
    emit({ phase: "visiting", term: step.term });
    if (!(await processItem(pending[0], step.term))) break; // breaker → fall through to completion
    stopKeepAlivePing();
    return; // ONE listing visited — yield; the countdown alarm resumes the job for the next
  }

  const status = aborted ? "error" : state.stopRequested ? "stopped" : "completed";
  // Stamp this run's terms as done-today BEFORE flipping the job to "completed" — so an
  // eviction between the two can't leave the job completed with its terms un-stamped, which
  // would make eligibleTerms re-pick (re-scrape) them next cycle. Only on a clean
  // completion — a stopped/errored run stays eligible for retry. (audit deep-pass Low)
  if (status === "completed") {
    const doneAt = new Date().toISOString();
    for (const t of await getAllRecords("search_terms")) {
      if (startedJob.terms.includes(t.term)) await putRecord("search_terms", { ...t, lastDoneAt: doneAt });
    }
  }
  await updateJob(startedJob.id, (finalJob) => ({
    ...finalJob,
    status,
    reason: aborted ? "too_many_consecutive_failures" : finalJob?.reason,
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  state.running = false;
  state.paused = false;
  state.stopRequested = false;
  await stopKeepAlive();
  emit({ running: false, phase: aborted ? "error" : "done", status, currentUrl: "", queue: 0 });
}

async function persistSearchDone(jobId, searchDoneSet) {
  await updateJob(jobId, (job) => ({ ...job, searchDone: [...searchDoneSet], updatedAt: new Date().toISOString() }));
}

// ---- durability: resume an interrupted job after a service-worker restart ----

// Keep the worker alive only while a tick is actively navigating/extracting. Each
// deliberate one-listing or term-gap yield stops the API ping; the durable alarms
// own the idle wait and wake the next tick. This avoids an indefinitely-live MV3
// worker while retaining protection during long review extraction.
let keepAlivePing = null;
function stopKeepAlivePing() {
  if (!keepAlivePing) return;
  clearInterval(keepAlivePing);
  keepAlivePing = null;
}

async function startKeepAlive() {
  if (!keepAlivePing) {
    keepAlivePing = setInterval(() => {
      try {
        chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
      } catch {
        // ignore — best-effort keepalive
      }
    }, 20000);
  }
  try {
    await chrome.alarms.create(JOB_KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  } catch {
    // alarms unavailable — jobs still run, just not resumable after a SW kill.
  }
}

async function stopKeepAlive() {
  stopKeepAlivePing();
  try {
    await Promise.all([
      chrome.alarms.clear(JOB_KEEPALIVE_ALARM),
      chrome.alarms.clear(TERM_GAP_ALARM),
    ]);
  } catch {
    // ignore
  }
}

async function scheduleTermGapResume(gapUntil) {
  try {
    await chrome.alarms.create(TERM_GAP_ALARM, {
      delayInMinutes: termGapAlarmDelayMinutes(gapUntil),
    });
  } catch {
    // JOB_KEEPALIVE/QUEUE_RUN still provide a slower fallback wake.
  }
}

async function resumeInterruptedJob() {
  // If a Stop was requested in this SW lifetime, never resurrect — covers the
  // window between Stop setting state.running=false and the "stopped" row write. (M-2)
  if (state.stopRequested) return;
  // claimRunner covers loopAlive (a loop is live) AND launching (another resume
  // path — e.g. the top-level init racing onStartup — is mid-flight). Without
  // the launching guard both callers passed the bare loopAlive check and double-
  // launched on a Chrome restart.
  if (!claimRunner()) return;
  try {
    const jobs = await getAllRecords("jobs");
    const job = jobs.find((j) => j.status === "running");
    if (!job) {
      await stopKeepAlive();
      return;
    }
    // URLs left mid-visit when the worker died must be retried, not skipped. The
    // queue is URL-keyed (global), so reset every processing row back to pending.
    await resetOrphanProcessing();
    launchJob(job);
  } finally {
    state.launching = false;
  }
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === JOB_KEEPALIVE_ALARM) guardedResume();
  if (alarm.name === QUEUE_RUN_ALARM) onQueueAlarm();
  if (alarm.name === TERM_GAP_ALARM) onTermGapAlarm();
});

async function onTermGapAlarm() {
  const running = (await getAllRecords("jobs")).find((job) => job?.status === "running");
  if (!running) return;
  await resumeInterruptedJob();
  // The term-gap wake just performed an auto-run tick earlier than the old queue
  // countdown. Re-arm that countdown from now so the next listing still receives
  // the full configured interval. Manual jobs keep their independent cadence.
  if (running.source === "auto") {
    const settings = await getSettings();
    if (settings.autoRunEnabled) await scheduleQueueRun(settings);
  }
}

// The QUEUE_RUN alarm (the countdown) advances the run one listing per tick. This
// 0.5-min keepalive alarm is now ONLY a stall safety net: it resumes the in-flight
// job ONLY when no countdown is scheduled to advance it (e.g. a manual Run-all with
// auto-run off, or a lost alarm). During normal auto-run pacing a QUEUE_RUN alarm is
// always pending, so this does nothing — otherwise it would sneak an extra URL in
// between countdowns (double-pacing).
// Resume an interrupted job ONLY if the countdown isn't about to do it anyway. Without
// this guard, each SW restart fires an immediate extra scrape OUTSIDE the user's interval
// (double-pacing → re-hammers Etsy faster than configured). Used by BOTH the keepalive
// watchdog and the init path. (audit HIGH-1)
async function guardedResume() {
  if (state.loopAlive || state.launching || state.stopRequested) return;
  let pending = null;
  try {
    pending = await chrome.alarms.get(QUEUE_RUN_ALARM);
  } catch {
    pending = null;
  }
  if (pending) {
    // The QUEUE_RUN countdown advances AUTO runs on the user's interval — don't double up.
    // A MANUAL run isn't part of that cycle, so without this it would crawl at the auto
    // interval whenever auto-run is on; advance it here instead. The claimRunner latch
    // still guarantees no double-launch if both triggers fire. (audit deep-pass #13)
    const running = (await getAllRecords("jobs")).find((j) => j && j.status === "running");
    if (!running || running.source !== "manual") return;
  }
  await resumeInterruptedJob();
}

// One-shot alarm fired: run this cycle, then re-arm the next one with a freshly
// jittered delay (a periodic alarm can't vary its period, so we re-arm each tick).
async function onQueueAlarm() {
  try {
    await runQueuedTerms();
  } finally {
    const settings = await getSettings();
    if (settings.autoRunEnabled) await scheduleQueueRun(settings);
  }
}

// ---- queued search terms (pills) + interval auto-run ----

const QUEUE_RUN_ALARM = "etsy-queue-run";

function termId(term) {
  let hash = 0;
  const key = String(term).toLowerCase();
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return `term_${hash.toString(36)}`;
}

async function listTerms() {
  const rows = await getAllRecords("search_terms");
  return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

async function addTerms(input) {
  const terms = parseSearchTerms(input);
  const now = new Date().toISOString();
  const existing = new Set((await getAllRecords("search_terms")).map((t) => t.id));
  let added = 0;
  for (const term of terms) {
    state.cancelledTerms.delete(term); // re-adding/re-running un-cancels a term
    const id = termId(term);
    if (existing.has(id)) continue;
    await putRecord("search_terms", { id, term, createdAt: now, lastRunAt: "" });
    existing.add(id);
    added += 1;
  }
  return { added, terms: await listTerms() };
}

// Strip a term from every job's terms[] so a running/recent job can't re-surface
// it as an un-removable pill after the user removes it. (bug, 2026-06-26)
async function stripTermFromJobs(term) {
  if (!term) return;
  for (const j of await getAllRecords("jobs")) {
    const terms = (j.terms || []).filter((t) => t !== term);
    const searchDone = (j.searchDone || []).filter((k) => String(k).split("|")[0] !== term);
    if (terms.length !== (j.terms || []).length || searchDone.length !== (j.searchDone || []).length) {
      // Drop the term AND its walked-page records, so no job re-discovers it and a
      // later re-add starts fresh.
      await putRecord("jobs", { ...j, terms, searchDone });
    }
  }
}

// Remove a term's leftover PENDING/FAILED queue rows so they don't linger as a
// stuck "term (N)" tab in the remaining-URL list after the term is removed. A URL
// still wanted by another term keeps that association; one wanted only by this
// term is deleted. Already-scraped (done) rows are left alone. (bug, 2026-06-26)
async function stripTermFromQueue(term) {
  if (!term) return;
  // Full scan + robust match (terms[] OR searchTerm OR term) — the `terms` index
  // misses rows whose term is only in the scalar `searchTerm`, which is why a
  // removed term's URLs kept lingering. All statuses (incl. done) so a re-add
  // starts fresh. A URL still wanted by another term keeps that association; the
  // `listings` collection is untouched.
  for (const r of await getAllRecords("listing_urls")) {
    if (!((r.terms || []).includes(term) || r.searchTerm === term || r.term === term)) continue;
    const terms = (r.terms || []).filter((t) => t !== term);
    if (terms.length === 0) {
      await deleteRecord("listing_urls", r.id);
    } else {
      await putRecord("listing_urls", { ...r, terms, term: terms[0], searchTerm: terms[0], updatedAt: new Date().toISOString() });
    }
  }
}

async function removeTerm(id) {
  // id is a real search_terms id, OR a synthetic "job:<term>" for a term surfaced
  // from a running job. Resolve the term and remove it from BOTH places so the
  // pill actually goes away (and doesn't get re-surfaced by the running job).
  let term = "";
  let realId = null;
  if (typeof id === "string" && id.startsWith("job:")) {
    term = id.slice(4);
  } else if (id) {
    term = (await getRecord("search_terms", id))?.term || "";
    realId = id;
  }
  if (term) state.cancelledTerms.add(term); // halt the live runner's work on this term
  // Strip the term from durable job/queue state FIRST, then delete the pill — so an
  // eviction between can't leave the pill gone while the term still lingers in a job
  // (session.js would resurface it as an un-removable "job:" pill). (audit deep-pass Low)
  await stripTermFromJobs(term);
  await stripTermFromQueue(term); // clear its leftover pending URLs (no stuck tab)
  if (realId) await deleteRecord("search_terms", realId);
  return { terms: await listTerms() };
}

async function clearTerms() {
  // Strip durable jobs FIRST. If Chrome evicts the worker mid-clear, an empty job
  // cannot resume and recreate supposedly-cleared synthetic term pills.
  const jobs = await getAllRecords("jobs");
  for (const j of jobs) {
    for (const t of j.terms || []) state.cancelledTerms.add(t);
    if (Array.isArray(j.terms) && j.terms.length) {
      await updateJob(j.id, (current) => ({ ...current, terms: [], searchDone: [] }));
    }
  }
  await clearStore("search_terms");
  // Clear queue = full queue reset: wipe the whole listing_urls store (the
  // `listings` collection is a separate store and is untouched).
  await clearStore("listing_urls");
  return { terms: [] };
}

// Run (or CONTINUE) the given terms. For each term we CONTINUE — seed the pages
// already walked so the runner skips them and visits the URLs already in the
// (global) queue — ONLY when there's leftover work: pending URLs to visit, OR
// un-walked pages still to discover. A term that's fully walked with nothing
// pending (done, or its URLs were cleared) re-discovers FRESH, so ▶ / Run all is
// never a no-op ("Batch Complete"). To force a fresh re-scrape, remove + re-add a
// term (removal clears its searchDone via stripTermFromJobs).
async function runTerms(terms, pagesPerTerm, source = "manual") {
  if (!claimRunner()) return { started: false, reason: "already_running" };
  try {
    let job;
    try {
      job = createJob({ terms, pagesPerTerm, source });
    } catch (error) {
      return { started: false, reason: error.message };
    }
    const want = new Set(job.terms);
    // Pages already walked per term (across all jobs).
    const walkedByTerm = new Map();
    for (const j of await getAllRecords("jobs")) {
      for (const k of j.searchDone || []) {
        if (typeof k !== "string") continue;
        const t = k.split("|")[0];
        if (!want.has(t)) continue;
        if (!walkedByTerm.has(t)) walkedByTerm.set(t, new Set());
        walkedByTerm.get(t).add(k);
      }
    }
    // Which terms still have URLs to visit.
    const hasPending = new Set();
    await Promise.all(
      [...want].map(async (term) => {
        const rows = await getAllByIndex("listing_urls", "terms", term);
        if (rows.some((row) => row.status === "pending" || row.status === "processing")) {
          hasPending.add(term);
        }
      }),
    );
    // Seed walked pages only for terms with leftover work (else re-discover fresh).
    const seed = new Set();
    let continued = false;
    for (const t of want) {
      const walked = walkedByTerm.get(t) || new Set();
      if (shouldContinueTerm({ walkedCount: walked.size, hasPending: hasPending.has(t), pagesPerTerm: job.pagesPerTerm })) {
        for (const k of walked) seed.add(k);
        if (walked.size) continued = true;
      }
    }
    if (seed.size) job.searchDone = [...seed];
    await putRecord("jobs", job);
    await addTerms(job.terms); // ensure every run's terms show up as queue pills
    const now = new Date().toISOString();
    for (const t of await getAllRecords("search_terms")) {
      if (job.terms.includes(t.term)) await putRecord("search_terms", { ...t, lastRunAt: now });
    }
    // A run is actually starting → clear any post-block cooldown so a manual ▶ retry (or
    // a naturally-expired one) lets auto-run resume normally afterward. (audit BLOCKER-1)
    await saveSettings({ blockedUntil: 0 });
    launchJob(job);
    return { started: true, jobId: job.id, resumed: continued };
  } finally {
    state.launching = false;
  }
}

// Once-per-day guard: has this URL's listing already been scraped today? A
// listing scraped today is not re-scraped until the calendar date rolls over
// (after which it counts as a fresh scrape).
async function scrapedToday(url, nowMs) {
  const listingId = extractListingId(url);
  if (!listingId) return false;
  const listing = await getRecord("listings", `listing_${listingId}`);
  // Key off lastVisitedAt (a real listing-page visit), NOT lastScrapedAt — the
  // latter is also bumped by manual search-card captures, which carry no demand/
  // reviews and must still get a full visit.
  return !!listing && sameCalendarDay(listing.lastVisitedAt, nowMs);
}

// Remove a single URL from the queue (the × in the remaining list): delete its
// pending/failed listing_urls rows for that term across jobs. Rows being visited
// right now (processing) are left alone so we don't race the runner.
async function removeQueuedUrl(url, term) {
  const id = urlQueueId(url);
  const row = await getRecord("listing_urls", id);
  if (!row) return { removed: 0 };
  // One canonical row per URL: drop just this term's association, and TOMBSTONE the
  // row once no term still wants it (or when no term was specified). We keep the row
  // with status "removed" instead of deleting it so a later re-discovery of the same
  // search page won't resurrect a URL the user intentionally deleted. (To truly reset
  // a term and re-scrape from scratch, remove + re-add the term — that hard-clears its
  // rows and searchDone.) "removed" is excluded from all counts/lists/visits.
  const terms = (row.terms || []).filter((t) => t !== term);
  if (!term || terms.length === 0) {
    await putRecord("listing_urls", { ...row, status: "removed", removedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  } else {
    await putRecord("listing_urls", { ...row, terms, term: terms[0], searchTerm: terms[0], updatedAt: new Date().toISOString() });
  }
  return { removed: 1 };
}

// Click a queued term to CONTINUE just THAT term: visit the URLs already
// discovered for it WITHOUT re-running the search. We gather every search page
// already walked for the term (across ALL past jobs, incl. multi-term "Run all"
// runs) and seed a fresh single-term job's searchDone with them — so the runner
// skips discovery for those pages and goes straight to visiting. The URL-keyed
// queue is global, so the visit step finds the term's pending URLs regardless of
// which job discovered them. Un-walked pages (e.g. pagesPerTerm raised) are still
// discovered. A term with nothing walked just runs fresh. (bug, 2026-06-26)
async function continueOrRunTerm(term, pagesPerTerm) {
  // runTerms already continues (seeds walked pages); this is just the single-term entry.
  return runTerms([term], pagesPerTerm);
}

// Retry a term's FAILED listing URLs: flip them back to pending, re-open the
// job(s) that owned them (a job goes "completed" even with some failures, which
// would otherwise be skipped by resume), then continue the term so they're
// re-visited. Reuses continueOrRunTerm / the resume machinery.
async function retryFailedTerm(term, pagesPerTerm) {
  const failed = (await getAllByIndex("listing_urls", "terms", term)).filter((u) => u.status === "failed");
  for (const u of failed) {
    await putRecord("listing_urls", { ...u, status: "pending", updatedAt: new Date().toISOString() });
  }
  // Re-open the term's most recent FINISHED job so continue RESUMES it (skips
  // re-walking search pages) and just re-visits the now-pending URLs.
  const jobs = await getAllRecords("jobs");
  const latest = jobs
    .filter((j) => Array.isArray(j.terms) && j.terms.includes(term))
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))[0];
  if (latest && (latest.status === "completed" || latest.status === "error")) {
    await putRecord("jobs", { ...latest, status: "stopped", updatedAt: new Date().toISOString() });
  }
  const result = await continueOrRunTerm(term, pagesPerTerm);
  return { reset: failed.length, ...result };
}

// Schedule the next auto-run cycle as a ONE-SHOT alarm whose delay is jittered
// ±randomizePct around the interval (when randomize is on). One-shot + re-arm
// (see onQueueAlarm) lets each cycle's wait differ; a periodic alarm cannot.
async function scheduleQueueRun(settings, { preserveExisting = false } = {}) {
  try {
    const minutes = jitteredAutoRunMinutes(settings);
    const existing = preserveExisting ? await chrome.alarms.get(QUEUE_RUN_ALARM) : null;
    const decision = queueAlarmDecision({ intervalMinutes: minutes, preserveExisting, existingAlarm: existing });
    if (decision === "preserve") return;
    await chrome.alarms.clear(QUEUE_RUN_ALARM);
    // 0.5 min = 30s floor (the UI's minimum). Unpacked extensions honor sub-minute
    // alarms; this also floors any low jitter so a randomized interval never dips
    // under 30s. No upper cap — the interval can be as large as the user sets.
    if (decision === "replace") await chrome.alarms.create(QUEUE_RUN_ALARM, { delayInMinutes: Math.max(0.5, minutes) });
  } catch {
    // alarms unavailable — interval auto-run won't fire.
  }
}

// One alarm tick = one cycle = ONE search term (collect its URLs, then visit
// them all). We run the least-recently-run term (never-run first), so each tick
// advances to a different term and the queue loops back to the top once every
// term has had a turn. The interval is the wait between cycles.
async function runQueuedTerms() {
  if (state.loopAlive || state.launching) return; // runTerms re-claims the slot atomically
  const settings = await getSettings();
  if (!settings.autoRunEnabled) return; // toggled off after the alarm was set
  // THE term-switching fix: a run interrupted by a service-worker death is still
  // "running" in the DB even though loopAlive is false. The old guard only checked
  // the in-memory loop, so this alarm grabbed a DIFFERENT term every time the worker
  // died mid-run — it never finished one term. Now: if any job is still in flight,
  // RESUME it (so the current term finishes) instead of starting a new term.
  const jobs = await getAllRecords("jobs");
  if (!shouldStartNewCycle(jobs)) {
    if (jobs.some((j) => j && j.status === "running")) await resumeInterruptedJob();
    return; // a paused job is left alone; a running one is resumed — never switch terms
  }
  // No job in flight → we would start a NEW cycle. Respect the post-block cooldown so a
  // tripped circuit breaker isn't undone by the very next interval. (audit BLOCKER-1)
  if (inBlockCooldown(settings, Date.now())) return;
  // Belt-and-suspenders: even if settings.blockedUntil was lost to an eviction, derive the
  // cooldown from the durable error job so we still don't re-hammer a block. (deep-pass #8)
  if (recentBlockError(jobs, blockCooldownMs(settings), Date.now())) return;
  const rows = await getAllRecords("search_terms");
  // ONE job for the terms NOT already finished today, in creation order. planJobSteps
  // drains each completely before the next (no per-tick rotation). Skipping done-today
  // terms is what stops the loop-back-and-re-search bug AND lets a term added mid-run
  // get picked next — and when everything's done for the day, we idle (no job) until a
  // new term is added or the calendar day rolls over and they're all eligible again.
  const terms = eligibleTerms(rows, Date.now());
  if (terms.length === 0) {
    // No NEW work. Instead of idling the countdown, re-visit FAILED URLs still under the
    // auto-retry cap (transient failures get another shot; permanently-broken ones are left
    // after the cap). Reset them to pending, bump their auto-retry count, and run their
    // terms — paced by the same interval + cooldown so it won't hammer Etsy. (auto-retry-failed)
    const { urls, terms: failedTerms } = failedToAutoRetry(await getAllRecords("listing_urls"), Number(settings.autoRetryFailed) || 0);
    if (!urls.length) return; // truly nothing to do → idle until a new term / next day
    const now = new Date().toISOString();
    for (const u of urls) {
      await putRecord("listing_urls", { ...u, status: "pending", autoRetries: (Number(u.autoRetries) || 0) + 1, updatedAt: now });
    }
    await runTerms(failedTerms, settings.queuePagesPerTerm || 10, "auto");
    return;
  }
  await runTerms(terms, settings.queuePagesPerTerm || 10, "auto");
}

// Serialize saves per listing id so a passive auto-save and a batch visit of the
// same URL can't interleave their read-modify-write and drop a demand_history
// append (or double-count listingCount). Different ids still save concurrently.
const saveQueue = createKeyedQueue();

// Serialize ALL read-modify-write updates to a single jobs row, so concurrent writers —
// the runJob loop's searchDone / stats / between-terms-gate writes vs a setRunnerState
// pause/stop arriving from a message handler — can't interleave their get→put and clobber
// each other. The clobber dropped a just-walked searchDone page, forcing a re-walk of that
// Etsy search page outside the anti-block cadence. Each task re-reads the row INSIDE the
// serialized section, so a later write preserves an earlier one's fields. (audit deep-pass High #3)
const jobQueue = createKeyedQueue();
function updateJob(id, mutator) {
  if (!id) return Promise.resolve(null);
  return jobQueue(id, async () => {
    const job = await getRecord("jobs", id);
    if (!job) return null;
    const next = mutator(job);
    if (next) await putRecord("jobs", next);
    return next;
  });
}

function saveListing(listing) {
  if (!listing?.id) return saveListingNow(listing);
  return saveQueue(listing.id, () => saveListingNow(listing));
}

async function saveListingNow(listing) {
  // O(1) lookup by primary key (id = `listing_<listingId>`) instead of scanning the whole
  // store. The get→put runs under a SHARED listings lock so a cross-context bulk writer
  // (Shop View CSV import, EXCLUSIVE) can't overwrite this save mid-flight. (deep-pass #16)
  const { existing, saved } = await withListingsLock("shared", async () => {
    const prev = listing.id ? await getRecord("listings", listing.id) : null;
    const next = recordScrape(prev || null, listing);
    await putRecord("listings", next);
    return { existing: prev, saved: next };
  });

  if (!existing) state.listingCount += 1;
  // Maintain withDemandCount O(1): count it the moment a listing FIRST gains demand
  // (whether brand-new or an existing row updated with demand it lacked before).
  const hadDemand = existing && (existing.demandValue > 0 || existing.demandText);
  const hasDemand = saved.demandValue > 0 || saved.demandText;
  if (hasDemand && !hadDemand) state.withDemandCount += 1;
  const total = state.listingCount;
  await setBadge(total);
  broadcast({ action: "collection.update", total, withDemand: state.withDemandCount, isNew: !existing, item: feedItem(saved) });
  await maybeAutoExport(total);
}

// Auto-download a CSV of everything once enough new listings have accumulated.
async function maybeAutoExport(total) {
  const settings = await getSettings();
  if (!shouldAutoExport(total, settings)) return;
  try {
    // Build the CSV via a cursor (one row in memory at a time) accumulating row STRINGS
    // in an array and joining once — linear. (Was `${acc}\n${line}` which re-copied the
    // whole accumulated string every row → O(n²), freezing the SW at ~180k rows.) Output
    // is byte-identical to rowsToCsv. (audit BLOCKER-2 / M-4)
    const lines = await reduceRecords(
      "listings",
      (acc, row) => {
        acc.push(csvRowLine(row));
        return acc;
      },
      [csvHeaderLine()],
    );
    const csv = lines.join("\n");
    const filename = makeExportFilename("etsy-auto-export");
    await downloadCsv(filename, csv, false);
    broadcast({ action: "collection.exported", total, filename, auto: true });
    console.log("[etsy-scraper] auto-export: downloaded %d listings → %s (silent — check your Downloads folder)", total, filename);
    if (settings.clearAfterExport) {
      // "Clear after each download": the batch is safely in the CSV, so wipe the
      // collection and reset the watermark — the next batch accumulates from zero. Reset
      // the watermark BEFORE wiping so an eviction between can't leave a stale-high
      // watermark that suppresses future auto-export. (audit deep-pass Low)
      await saveSettings({ lastExportTotal: 0 });
      await withListingsLock("exclusive", () => clearStore("listings")); // exclude concurrent saves (deep-pass Med)
      state.listingCount = 0;
      state.withDemandCount = 0;
      await setBadge(0);
      broadcast({ action: "collection.update", total: 0, withDemand: 0 });
      console.log("[etsy-scraper] auto-export: cleared collection after download");
    } else {
      // Advance the watermark ONLY after a real download. (Previously this ran in a
      // `finally` — so a failed/silent download advanced it anyway and auto-export
      // stopped firing.) On failure we DON'T advance, so it retries next save.
      await saveSettings({ lastExportTotal: total });
    }
  } catch (error) {
    // NON-FATAL: a failed auto-export must NEVER crash the listing visit (the data is
    // safe in IndexedDB; manual export still works). Logged so a real failure is visible.
    console.warn("[etsy-scraper] auto-export FAILED (will retry next save):", error?.message || error);
  }
}

async function downloadCsv(filename, text, saveAs) {
  // MV3 service workers have no URL.createObjectURL — use a data: URL so SW-initiated
  // downloads (auto-export) work instead of throwing and crashing the listing save.
  const url = `data:text/csv;charset=utf-8,${encodeURIComponent(text)}`;
  const settings = await getSettings();
  await chrome.downloads.download({ url, filename: withSubfolder(filename, settings.downloadSubfolder), saveAs });
}

// Build a sparse listing record from a search-result card so manual browsing
// accumulates into the same `listings` collection as a scrape, tagged with the
// keyword. Only identity + reliably-present card fields are set; review/demand
// counts are left undefined so this never downgrades a richer record on merge
// (the next listing-page visit fills them in). (source: "manual")
function listingFromSearchResult(result, keyword) {
  return {
    id: `listing_${result.listingId}`,
    listingId: result.listingId,
    url: result.url,
    title: result.title || "",
    price: result.price || "",
    shopName: result.shopName || "",
    imageUrl: result.imageUrl || "",
    source: "manual",
    searchTerm: keyword || result.keyword || "",
  };
}

// Accumulate full search-result captures (keyword + page + position + history).
// opts.captureListings (manual browse) also upserts each card into `listings`.
async function saveSearchResults(payload, opts = {}) {
  const results = payload?.results;
  if (!Array.isArray(results) || results.length === 0) return { saved: 0 };
  const now = payload.capturedAt || new Date().toISOString();
  for (const result of results) {
    if (!result?.listingId) continue;
    const key = searchResultKey(result.keyword, result.listingId);
    const existing = await getRecord("search_results", key);
    await putRecord("search_results", mergeSearchResult(existing, result, now));
    if (opts.captureListings) await saveListing(listingFromSearchResult(result, payload.keyword));
  }
  const total = await countRecords("search_results");
  const top = results[0];
  broadcast({
    action: "search.update",
    total,
    item: { keyword: payload.keyword, page: payload.page, count: results.length, title: top?.title || "", position: top?.position || 1, at: now },
  });
  return { saved: results.length, total };
}

async function updateJobStats(jobId, delta, set = {}) {
  // `set` carries non-additive fields persisted on the job row itself (e.g.
  // consecutiveFailures), so the circuit-breaker survives a service-worker kill.
  await updateJob(jobId, (job) => {
    const stats = { ...(job.stats || {}) };
    for (const [key, value] of Object.entries(delta)) {
      stats[key] = (stats[key] || 0) + value;
    }
    return { ...job, ...set, stats, updatedAt: new Date().toISOString() };
  });
}

async function getOrCreateRunnerTab() {
  if (state.tabId) {
    try {
      return await chrome.tabs.get(state.tabId);
    } catch {
      state.tabId = null;
    }
  }
  const tab = await chrome.tabs.create({ url: "https://www.etsy.com", active: false });
  state.tabId = tab.id;
  return tab;
}

function navigateAndWait(tabId, url) {
  // Sink-side allowlist: every writer already normalizes queue URLs to
  // https://www.etsy.com/..., but revalidate at the sink so a future writer
  // can't turn this into an arbitrary-navigation primitive.
  if (typeof url !== "string" || !url.startsWith("https://www.etsy.com/")) {
    return Promise.reject(new Error("navigateAndWait: refusing non-Etsy URL"));
  }
  return new Promise((resolve, reject) => {
    const timeoutMs = randomInRange(RUNNER_DEFAULTS.navigationTimeoutMinMs, RUNNER_DEFAULTS.navigationTimeoutMaxMs);
    let settled = false;
    let sawLoading = false;
    const cleanup = () => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ timedOut: true });
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || settled) return;
      if (changeInfo.status === "loading") sawLoading = true;
      if (changeInfo.status === "complete" && sawLoading) {
        settled = true;
        cleanup();
        resolve({ timedOut: false });
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        settled = true;
        cleanup();
        reject(new Error(chrome.runtime.lastError.message));
      }
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}

function shouldStop() {
  return !state.running || state.stopRequested;
}

async function waitWhilePaused() {
  while (state.paused && !state.stopRequested) {
    await delay(1000);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function filterListings(listings, filter = {}) {
  const query = String(filter.q || "").trim().toLowerCase();
  const source = filter.source ? String(filter.source) : "";
  return listings.filter((row) => {
    if (source && row.source !== source) return false;
    if (!query) return true;
    return [row.title, row.shopName, row.url, row.searchTerm].some((value) =>
      String(value || "").toLowerCase().includes(query),
    );
  });
}
