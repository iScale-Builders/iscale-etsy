import { untilNextExport, autoExportOn, autoRunOn } from "./src/core/collection.js";
import { sanitizeSubfolder } from "./src/core/csv.js";

let settings = { autoExportEvery: 0, lastExportTotal: 0 };
let total = 0;

const els = {
  total: document.querySelector("#m-total strong"),
  demand: document.querySelector("#m-demand strong"),
  totalCard: document.getElementById("m-total"),
  feed: document.getElementById("feed"),
  feedEmpty: document.getElementById("feedEmpty"),
  clearFeed: document.getElementById("clearFeed"),
  autoEvery: document.getElementById("autoEvery"),
  autoExportNow: document.getElementById("autoExportNow"),
  downloadSubfolder: document.getElementById("downloadSubfolder"),
  autoStatus: document.getElementById("autoStatus"),
  autoExportToggle: document.getElementById("autoExportToggle"),
  clearAfterExportToggle: document.getElementById("clearAfterExportToggle"),
  autoExportRow: document.getElementById("autoExportRow"),
  autoRunToggle: document.getElementById("autoRunToggle"),
  autoRunRow: document.getElementById("autoRunRow"),
  seg: document.getElementById("seg"),
  addTermInput: document.getElementById("addTermInput"),
  addTerm: document.getElementById("addTerm"),
  termPills: document.getElementById("termPills"),
  termsEmpty: document.getElementById("termsEmpty"),
  toggleQueue: document.getElementById("toggleQueue"),
  clearTerms: document.getElementById("clearTerms"),
  queueCount: document.getElementById("queueCount"),
  intervalInput: document.getElementById("intervalInput"),
  betweenTermsInput: document.getElementById("betweenTermsInput"),
  togglePending: document.getElementById("togglePending"),
  pendingList: document.getElementById("pendingList"),
  randomizeToggle: document.getElementById("randomizeToggle"),
  randomizePct: document.getElementById("randomizePct"),
  manualFirstReviewToggle: document.getElementById("manualFirstReviewToggle"),
  intervalStatus: document.getElementById("intervalStatus"),
  pagesInput: document.getElementById("pagesInput"),
  runStatus: document.getElementById("runStatus"),
  runStatusText: document.getElementById("runStatusText"),
  jobDiscovered: document.getElementById("jobDiscovered"),
  jobQueue: document.getElementById("jobQueue"),
  jobScraped: document.getElementById("jobScraped"),
  jobFailed: document.getElementById("jobFailed"),
  clearCollection: document.getElementById("clearCollection"),
  confirmModal: document.getElementById("confirmModal"),
  confirmText: document.getElementById("confirmText"),
  confirmDontAsk: document.getElementById("confirmDontAsk"),
  confirmOk: document.getElementById("confirmOk"),
  confirmCancel: document.getElementById("confirmCancel"),
};

// In-page confirm (a native confirm() closes the extension popup). Resolves true
// to proceed. Honors a persisted "Don't ask again" choice in localStorage.
function confirmDelete(message, alwaysAsk = false) {
  return new Promise((resolve) => {
    if (!alwaysAsk && localStorage.getItem("etsySkipDeleteConfirm") === "1") return resolve(true);
    els.confirmText.textContent = message;
    els.confirmDontAsk.checked = false;
    // Irreversible bulk wipes (alwaysAsk) hide the "don't ask again" option so the
    // confirm can never be silently disabled.
    const dontAskRow = els.confirmDontAsk.closest(".confirm-dontask");
    if (dontAskRow) dontAskRow.style.display = alwaysAsk ? "none" : "";
    els.confirmModal.hidden = false;
    const finish = (ok) => {
      els.confirmModal.hidden = true;
      els.confirmOk.onclick = null;
      els.confirmCancel.onclick = null;
      if (ok && !alwaysAsk && els.confirmDontAsk.checked) localStorage.setItem("etsySkipDeleteConfirm", "1");
      resolve(ok);
    };
    els.confirmOk.onclick = () => finish(true);
    els.confirmCancel.onclick = () => finish(false);
  });
}

let activeJobId = null;
let jobTimer = null;

document.getElementById("openShop").addEventListener("click", () => send("shop.open"));
els.autoEvery.addEventListener("change", saveAuto);
els.downloadSubfolder.addEventListener("change", async () => {
  const folder = sanitizeSubfolder(els.downloadSubfolder.value);
  els.downloadSubfolder.value = folder;
  settings = await send("settings.save", { settings: { downloadSubfolder: folder } });
});
els.autoExportNow.addEventListener("click", () => send("export.csv", { filenamePrefix: "etsy-collection" }));

els.clearCollection.addEventListener("click", async () => {
  const ok = await confirmDelete(
    "Delete ALL collected listings? This wipes your research collection. Your search terms and queue are kept. This cannot be undone — export a CSV first if you want a copy.",
    true,
  );
  if (!ok) return;
  await send("collection.clear");
  els.total.textContent = "0";
  els.demand.textContent = "0";
});

// Clear only the live-feed DISPLAY (the running list of names). Non-destructive:
// collected data, the counts above, and the CSV are untouched. New captures will
// start repopulating the feed as they come in.
els.clearFeed.addEventListener("click", () => {
  els.feed.replaceChildren();
  els.feedEmpty.hidden = false;
});

// ---- search queue (pills) + durable session observability ----
let queuedTerms = [];
let sessionTimer = null;

// Reads the durable session snapshot from storage so the queue + progress are
// visible after closing/reopening or a service-worker restart.
async function refreshSession() {
  const res = await sendRaw("session.status");
  if (!res.ok || !res.result) return;
  const s = res.result;
  renderPills(s.terms || []);
  const t = s.totals || {};
  els.jobDiscovered.textContent = Number(t.found || 0).toLocaleString();
  els.jobQueue.textContent = Number((t.pending || 0) + (t.processing || 0)).toLocaleString();
  els.jobScraped.textContent = Number(t.done || 0).toLocaleString();
  els.jobFailed.textContent = Number(t.failed || 0).toLocaleString();
  // Reflect an in-progress run in the banner even when the dashboard is (re)opened
  // mid-run, before the next job.progress broadcast arrives.
  if (s.activeJob?.status === "running") setJobStatus(null, "running");
  else if (s.activeJob?.status === "paused") setJobStatus(null, "paused");
  // Poll while a job is actively running so per-term counts stay live.
  const running = s.activeJob && s.activeJob.status === "running";
  if (running && !sessionTimer) sessionTimer = setInterval(refreshSession, 4000);
  if (!running && sessionTimer) {
    clearInterval(sessionTimer);
    sessionTimer = null;
  }
}

let queueCollapsed = localStorage.getItem("etsyQueueCollapsed") === "1";

function applyQueueCollapsed() {
  els.termPills.classList.toggle("collapsed", queueCollapsed && queuedTerms.length > 0);
  els.toggleQueue.textContent = queueCollapsed ? "Expand ▸" : "Collapse ▾";
  els.toggleQueue.setAttribute("aria-expanded", String(!queueCollapsed));
  els.toggleQueue.hidden = queuedTerms.length === 0;
}

els.toggleQueue.addEventListener("click", () => {
  queueCollapsed = !queueCollapsed;
  localStorage.setItem("etsyQueueCollapsed", queueCollapsed ? "1" : "0");
  applyQueueCollapsed();
});

function renderPills(terms) {
  queuedTerms = Array.isArray(terms) ? terms : [];
  els.termsEmpty.hidden = queuedTerms.length > 0;
  els.clearTerms.disabled = queuedTerms.length === 0;
  els.queueCount.textContent = queuedTerms.length ? `Queued terms (${queuedTerms.length})` : "Queued terms";
  els.termPills.innerHTML = queuedTerms
    .map((t) => {
      const found = Number(t.found || 0);
      const done = Number(t.done || 0);
      const searched = Number(t.pagesSearched || 0);
      const stat = found
        ? `<span class="pill-stat" title="${done} scraped of ${found} found${searched ? `, ${searched} page(s) searched` : ""}">${done}/${found}</span>`
        : searched
          ? `<span class="pill-stat" title="${searched} page(s) searched">…</span>`
          : "";
      return `<span class="pill" data-id="${escapeText(t.id)}" data-term="${escapeText(t.term)}"><span class="pill-label">${escapeText(t.term)}</span>${stat}<button class="pill-play" title="Run this term" aria-label="Run">▶</button><button class="pill-x" title="Remove" aria-label="Remove">✕</button></span>`;
    })
    .join("");
  applyQueueCollapsed();
}

els.addTerm.addEventListener("click", addQueuedTerm);
els.addTermInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addQueuedTerm();
});
async function addQueuedTerm() {
  const value = els.addTermInput.value.trim();
  if (!value) return;
  const res = await sendRaw("terms.add", { terms: value });
  if (res.ok) {
    els.addTermInput.value = "";
    refreshSession();
  }
}

els.clearTerms.addEventListener("click", async () => {
  if (queuedTerms.length === 0) return;
  if (!(await confirmDelete(`Clear all ${queuedTerms.length} queued term${queuedTerms.length === 1 ? "" : "s"} and their queued URLs?`))) return;
  await sendRaw("terms.clear");
  refreshSession();
});

els.termPills.addEventListener("click", async (event) => {
  const pill = event.target.closest(".pill");
  if (!pill) return;
  if (event.target.closest(".pill-x")) {
    if (!(await confirmDelete(`Delete “${pill.dataset.term}” and all its queued URLs?`))) return;
    await sendRaw("terms.remove", { id: pill.dataset.id });
    refreshSession();
  } else if (event.target.closest(".pill-play")) {
    await continueTerm(pill.dataset.term);
  }
});

// Clicking a term continues its unfinished run if it has leftover URLs/pages,
// otherwise starts it fresh (the backend decides which).
async function continueTerm(term) {
  const res = await sendRaw("queue.continue", { term, pagesPerTerm: els.pagesInput.value });
  if (res.ok && res.result.started) {
    activeJobId = res.result.jobId;
    setJobStatus(res.result.resumed ? `Continuing “${term}”…` : `Started “${term}”…`, "running");
    startJobPolling();
    refreshSession();
  } else {
    setJobStatus(res.result?.reason === "already_running" ? "A run is already in progress." : res.result?.reason || res.error || "Could not start");
  }
}


// Show/refresh the remaining (pending + in-progress) listing URLs, grouped by
// term. Read-only and on-demand — re-click to refresh.
els.togglePending.addEventListener("click", async () => {
  if (!els.pendingList.hidden) {
    els.pendingList.hidden = true;
    els.togglePending.textContent = "Show remaining URLs";
    return;
  }
  els.togglePending.textContent = "Loading…";
  const res = await sendRaw("queue.pending");
  renderPending(res.ok ? res.result : { total: 0, urls: [] });
  els.pendingList.hidden = false;
  els.togglePending.textContent = "Hide remaining URLs";
});

// Throttled live refresh: while the list is open, re-fetch at most once every
// ~1.2s as scrape events arrive, preserving the user's scroll position.
let pendingRefreshScheduled = false;
function refreshPendingIfOpen() {
  if (els.pendingList.hidden || pendingRefreshScheduled) return;
  pendingRefreshScheduled = true;
  setTimeout(async () => {
    pendingRefreshScheduled = false;
    if (els.pendingList.hidden) return;
    const scroll = els.pendingList.scrollTop;
    const res = await sendRaw("queue.pending");
    renderPending(res.ok ? res.result : { total: 0, urls: [] });
    els.pendingList.scrollTop = scroll;
  }, 1200);
}

function groupByTerm(urls) {
  const m = new Map();
  for (const u of urls || []) {
    if (!m.has(u.term)) m.set(u.term, []);
    m.get(u.term).push(u);
  }
  return m;
}

const URL_PREFIX = "https://www.etsy.com/listing/";

// True only for https URLs on an etsy.com host. Used to gate what becomes a
// clickable link — rejects javascript:/data: and any non-Etsy host by construction.
// Mirrors shop.js safeHref so every link sink enforces the same allowlist.
function isEtsyHttpsUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "etsy.com" || u.hostname.endsWith(".etsy.com"));
  } catch {
    return false;
  }
}

// The single URL the runner is visiting RIGHT NOW, from the live job.progress feed
// (p.currentUrl). "scraping…" is driven off this — NOT the stored "processing"
// status, which gets stuck when the worker dies and would leave phantom scrapes.
let liveScrapingUrl = "";

function urlListEl(list) {
  const ul = document.createElement("ul");
  ul.className = "pending-urls";
  for (const u of list) {
    const li = document.createElement("li");
    // done = visited (✓); the one live URL = scraping…; everything else (incl. a
    // row stuck "processing") shows as pending with an × — no phantom scrapes.
    const shown = u.status === "done" ? "done" : u.url && u.url === liveScrapingUrl ? "scraping" : "pending";
    li.className = "url-row url-" + shown;
    const pg = document.createElement("span");
    pg.className = "url-page";
    pg.textContent = u.page ? `p${u.page}` : "—";
    li.appendChild(pg);
    const a = document.createElement("a");
    // A queue row's url is normally a normalized etsy.com/listing/ URL. Only make it
    // clickable when it really is https + an etsy.com host; anything else (a poisoned
    // or malformed row, a javascript:/data: value) renders inert. (deep-pass Low, sec)
    a.href = isEtsyHttpsUrl(u.url) ? u.url : "#";
    a.target = "_blank";
    a.rel = "noopener";
    // Trim the shared prefix from the visible text so the unique part is readable.
    a.textContent = u.url.startsWith(URL_PREFIX) ? u.url.slice(URL_PREFIX.length) : u.url;
    li.appendChild(a);
    if (shown === "done") {
      const ck = document.createElement("span");
      ck.className = "url-flag url-check";
      ck.title = "Visited";
      ck.textContent = "✓";
      li.appendChild(ck);
    } else if (shown === "scraping") {
      const now = document.createElement("span");
      now.className = "url-flag url-now";
      now.textContent = "scraping…";
      li.appendChild(now);
    } else {
      const x = document.createElement("button");
      x.className = "url-x";
      x.type = "button";
      x.title = "Remove from queue";
      x.dataset.url = u.url;
      x.dataset.term = u.term || "";
      x.textContent = "×";
      li.appendChild(x);
    }
    ul.appendChild(li);
  }
  return ul;
}

// One tab per search term (plus "All"). Kept across live refreshes so the view
// doesn't jump while you're looking at a term.
let activePendingTab = "__all__";
let lastPendingData = null;

// Render a term's pending block (+ failed block with a Retry button) into parent.
// Counts are the TRUE totals (may exceed the rendered list when capped).
function renderTermBlocks(parent, term, pendingList, failedList, pendingCount, failedCount, doneCount = 0) {
  if (pendingCount) {
    const head = document.createElement("div");
    head.className = "pending-term";
    head.textContent = `${term || "(no term)"} — ${pendingCount.toLocaleString()} left`;
    if (doneCount) {
      const v = document.createElement("span");
      v.className = "term-visited";
      v.textContent = ` · ${doneCount.toLocaleString()} visited`;
      head.appendChild(v);
    }
    parent.appendChild(head);
    parent.appendChild(urlListEl(pendingList));
  }
  if (failedCount) {
    const head = document.createElement("div");
    head.className = "pending-term failed-term";
    const label = document.createElement("span");
    label.textContent = `${term || "(no term)"} — ${failedCount.toLocaleString()} failed`;
    const retry = document.createElement("button");
    retry.className = "link-btn retry-btn";
    retry.type = "button";
    retry.dataset.term = term;
    retry.textContent = "Retry";
    head.appendChild(label);
    head.appendChild(retry);
    parent.appendChild(head);
    parent.appendChild(urlListEl(failedList));
  }
}

function renderPending(data) {
  lastPendingData = data;
  els.pendingList.replaceChildren();
  const pending = data.urls || [];
  const failed = (data.failed && data.failed.urls) || [];
  const pendingByTerm = groupByTerm(pending);
  const failedByTerm = groupByTerm(failed);
  const pendingCounts = data.counts || {};
  const doneCounts = data.doneCounts || {};
  const failedCounts = (data.failed && data.failed.counts) || {};
  const pendingTotal = data.total || 0;
  const failedTotal = (data.failed && data.failed.total) || 0;

  if (pendingTotal === 0 && failedTotal === 0) {
    const empty = document.createElement("p");
    empty.className = "auto-status";
    empty.style.margin = "0";
    empty.textContent = "No remaining URLs — nothing pending.";
    els.pendingList.appendChild(empty);
    return;
  }

  const hint = document.createElement("p");
  hint.className = "auto-status";
  hint.style.margin = "0 0 6px";
  hint.textContent = "All URLs begin etsy.com/listing/ — shown trimmed below.";
  els.pendingList.appendChild(hint);

  // Terms (and counts) come from the true per-term totals, so a term still shows
  // accurately even when its URLs were truncated out of the capped list.
  const terms = [...new Set([...Object.keys(pendingCounts), ...Object.keys(failedCounts)])].sort((a, b) => String(a).localeCompare(String(b)));
  if (activePendingTab !== "__all__" && !terms.includes(activePendingTab)) activePendingTab = "__all__";

  // Tab bar — one tab per term (+ "All"), each labelled with its combined count.
  const tabs = document.createElement("div");
  tabs.className = "url-tabs";
  const addTab = (key, label, count) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "url-tab" + (key === activePendingTab ? " active" : "");
    b.dataset.tab = key;
    b.textContent = `${label} (${count})`;
    tabs.appendChild(b);
  };
  addTab("__all__", "All", (pendingTotal + failedTotal).toLocaleString());
  for (const t of terms) {
    addTab(t, t || "(no term)", ((pendingCounts[t] || 0) + (failedCounts[t] || 0)).toLocaleString());
  }
  els.pendingList.appendChild(tabs);

  if (data.capped || (data.failed && data.failed.capped)) {
    const note = document.createElement("p");
    note.className = "auto-status";
    note.style.margin = "2px 0 4px";
    note.textContent = "Counts are exact; only the first 2,000 URLs of each list are shown.";
    els.pendingList.appendChild(note);
  }

  const body = document.createElement("div");
  const shown = activePendingTab === "__all__" ? terms : [activePendingTab];
  for (const t of shown) {
    renderTermBlocks(body, t, pendingByTerm.get(t) || [], failedByTerm.get(t) || [], pendingCounts[t] || 0, failedCounts[t] || 0, doneCounts[t] || 0);
  }
  els.pendingList.appendChild(body);
}

// Delegated clicks inside the list: switch term tab, or retry a term's failures.
els.pendingList.addEventListener("click", async (event) => {
  const tab = event.target.closest(".url-tab");
  if (tab) {
    activePendingTab = tab.dataset.tab;
    if (lastPendingData) renderPending(lastPendingData);
    return;
  }
  const x = event.target.closest(".url-x");
  if (x) {
    x.disabled = true;
    x.closest("li")?.remove(); // snappy; the throttled refresh corrects counts
    await sendRaw("queue.removeUrl", { url: x.dataset.url, term: x.dataset.term });
    refreshPendingIfOpen();
    return;
  }
  const btn = event.target.closest(".retry-btn");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "Retrying…";
  const res = await sendRaw("queue.retryFailed", { term: btn.dataset.term, pagesPerTerm: els.pagesInput.value });
  if (res.ok && res.result.started) {
    activeJobId = res.result.jobId;
    setJobStatus(`Retrying ${res.result.reset} failed in “${btn.dataset.term}”…`, "running");
    startJobPolling();
  } else if (res.ok) {
    setJobStatus(res.result.reason === "already_running" ? "A run is already in progress — failed URLs re-queued." : `Re-queued ${res.result.reset || 0} failed URL${res.result.reset === 1 ? "" : "s"}.`);
  } else {
    setJobStatus(res.error || "Could not retry");
  }
  refreshPendingIfOpen();
});

async function runTerms(terms) {
  if (!terms || terms.length === 0) return setJobStatus("No terms to run.");
  const res = await sendRaw("queue.run", { terms, pagesPerTerm: els.pagesInput.value });
  if (res.ok && res.result.started) {
    activeJobId = res.result.jobId;
    setJobStatus(`Started ${terms.length} term${terms.length === 1 ? "" : "s"}…`, "running");
    startJobPolling();
    refreshSession();
  } else {
    setJobStatus(res.result?.reason || res.error || "Could not start");
  }
}

// The interval input is in SECONDS with a 30s floor and NO maximum; internals
// (settings.searchIntervalMin, the jitter/schedule math) stay in MINUTES, so this
// converts at the boundary and clamps the input back to a valid value.
function intervalInputMinutes() {
  const seconds = Math.max(30, Number.parseInt(els.intervalInput.value, 10) || 30);
  els.intervalInput.value = seconds;
  return seconds / 60;
}

// Auto-save the cycle interval and pages-per-term on change (no Save button).
els.intervalInput.addEventListener("change", async () => {
  settings = await send("settings.save", { settings: { searchIntervalMin: intervalInputMinutes() } });
  renderIntervalStatus();
});
// Between-terms pause (0 = off) — its own setting, independent of the interval.
els.betweenTermsInput.addEventListener("change", async () => {
  // UI field is in MINUTES; stored canonically as betweenTermsSec (seconds).
  const minutes = Math.max(0, Number.parseInt(els.betweenTermsInput.value, 10) || 0);
  els.betweenTermsInput.value = minutes;
  settings = await send("settings.save", { settings: { betweenTermsSec: minutes * 60 } });
});
els.pagesInput.addEventListener("change", async () => {
  const pages = Math.max(1, Number.parseInt(els.pagesInput.value, 10) || 10);
  els.pagesInput.value = pages;
  settings = await send("settings.save", { settings: { queuePagesPerTerm: pages } });
});
// Randomize-interval (jitter) — auto-saves like the rest of the auto-run row.
els.randomizeToggle.addEventListener("change", async () => {
  settings = await send("settings.save", { settings: { randomizeInterval: els.randomizeToggle.checked } });
  renderIntervalStatus();
});
els.randomizePct.addEventListener("change", async () => {
  const pct = Math.max(0, Math.min(95, Number.parseInt(els.randomizePct.value, 10) || 0));
  els.randomizePct.value = pct;
  settings = await send("settings.save", { settings: { randomizePct: pct } });
  renderIntervalStatus();
});
els.manualFirstReviewToggle.addEventListener("change", async () => {
  settings = await send("settings.save", { settings: { manualFirstReview: els.manualFirstReviewToggle.checked } });
});

els.autoRunToggle.addEventListener("change", async () => {
  settings = await send("settings.save", {
    settings: { autoRunEnabled: els.autoRunToggle.checked, searchIntervalMin: intervalInputMinutes() },
  });
  renderIntervalStatus();
});

els.autoExportToggle.addEventListener("change", async () => {
  const every = Math.max(1, Number.parseInt(els.autoEvery.value, 10) || 500);
  els.autoEvery.value = every;
  settings = await send("settings.save", {
    settings: { autoExportEnabled: els.autoExportToggle.checked, autoExportEvery: every },
  });
  renderAutoStatus();
});

// Auto-clear the collection after each download (keeps local storage small — each
// batch is exported then wiped). Auto-saves like the rest of the auto-export row.
els.clearAfterExportToggle.addEventListener("change", async () => {
  settings = await send("settings.save", { settings: { clearAfterExport: els.clearAfterExportToggle.checked } });
});

// Live countdown to the next auto-run cycle (driven by the actual scheduled alarm
// time, so it reflects the ±% jitter).
let countdownTimer = null;
let nextRunAt = 0;

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

async function refreshNextRun() {
  if (!autoRunOn(settings)) return stopCountdown();
  const res = await sendRaw("queue.nextRun");
  nextRunAt = (res.ok && res.result?.at) || 0;
  if (!countdownTimer) countdownTimer = setInterval(tickCountdown, 1000);
  tickCountdown();
}

function tickCountdown() {
  if (!autoRunOn(settings)) return stopCountdown();
  // During a between-terms pause, that countdown owns the status line — don't overwrite
  // it with the per-listing "next cycle" timer (which is what made the pause look like a
  // stuck 30s loop). The between-terms ticker clears itself when the pause ends.
  if (betweenTermsUntil && betweenTermsUntil - Date.now() > 0) return;
  const ms = nextRunAt - Date.now();
  if (!nextRunAt || ms <= 0) {
    els.intervalStatus.textContent = "Auto-run — starting the next cycle…";
    stopCountdown();
    setTimeout(refreshNextRun, 3000); // the alarm re-arms after each cycle; pick up the new time
    return;
  }
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  els.intervalStatus.textContent = `Auto-run on — next cycle in ${m}:${String(s).padStart(2, "0")}.`;
}

// BETWEEN-TERMS pause countdown — one honest "next term in M:SS" timer for the whole
// pause, instead of the per-listing 30s timer ticking 4× and looking stuck. Driven by
// the durable deadline (`gapUntil`) the runner sends with the "between-terms" progress
// event. Independent of auto-run so it also shows during a manual Run-all pause.
let betweenTermsTimer = null;
let betweenTermsUntil = 0;
let betweenTermsTerm = "";

function stopBetweenTermsCountdown() {
  if (betweenTermsTimer) {
    clearInterval(betweenTermsTimer);
    betweenTermsTimer = null;
  }
  betweenTermsUntil = 0;
  betweenTermsTerm = "";
}

function tickBetweenTerms() {
  const ms = betweenTermsUntil - Date.now();
  if (!betweenTermsUntil || ms <= 0) {
    stopBetweenTermsCountdown();
    return;
  }
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const time = `${m}:${String(s).padStart(2, "0")}`;
  const who = betweenTermsTerm ? ` “${betweenTermsTerm}”` : "";
  setJobStatus(`Pausing before the next term${who} — ${time} left…`, "running");
  els.intervalStatus.textContent = `Auto-run on — next term${who} in ${time}.`;
}

function startBetweenTermsCountdown(term, until) {
  betweenTermsTerm = term || "";
  betweenTermsUntil = Number(until) || 0;
  if (!betweenTermsUntil) {
    // No deadline sent (older runner) — fall back to a plain message, no countdown.
    setJobStatus(`Pausing before the next term${betweenTermsTerm ? ` “${betweenTermsTerm}”` : ""}…`, "running");
    return;
  }
  if (!betweenTermsTimer) betweenTermsTimer = setInterval(tickBetweenTerms, 1000);
  tickBetweenTerms();
}

function renderIntervalStatus() {
  const on = autoRunOn(settings);
  els.autoRunRow.classList.toggle("is-off", !on);
  if (on) {
    refreshNextRun(); // start/refresh the live countdown
  } else {
    stopCountdown();
    els.intervalStatus.textContent = "Off — terms run only when you click Run all.";
  }
}

document.getElementById("pauseJob").addEventListener("click", async () => {
  const ok = (await sendRaw("job.pause")).ok;
  setJobStatus(ok ? "Paused" : "Couldn't pause", ok ? "paused" : "error");
});
// Run all = run every queued term; if a run is paused/unfinished, resume it
// instead (so there's no dead-end after Pause without a separate resume button).
document.getElementById("runAll").addEventListener("click", async () => {
  const res = await sendRaw("job.resume");
  if (res.ok && res.result?.resumed) {
    // Seed activeJobId so refreshActiveJob polling works (the "unpaused" mode doesn't
    // return a jobId), and render the last known progress so the banner shows the actual
    // TERM instead of a bare "Running" until the next live tick arrives. (audit M-8 / LOW-24)
    const [stats, session] = await Promise.all([send("collection.stats"), send("session.status")]);
    activeJobId = res.result.jobId || session?.activeJob?.id || activeJobId;
    if (stats?.jobProgress) onJobProgress(stats.jobProgress);
    else setJobStatus(res.result.mode === "relaunched" ? "Resuming…" : "Running", "running");
    startJobPolling();
    refreshSession();
    return;
  }
  runTerms(queuedTerms.map((t) => t.term));
});
document.getElementById("stopJob").addEventListener("click", async () => {
  const ok = (await sendRaw("job.stop")).ok;
  setJobStatus(ok ? "Stopping…" : "Couldn't stop", ok ? "stopped" : "error");
});

// The single run-state indicator. `state` (idle|running|paused|stopped|error)
// sets the colour/animation; text is the live activity line.
function setJobStatus(text, state) {
  if (text != null) els.runStatusText.textContent = text;
  if (state) els.runStatus.className = "run-status " + state;
}
function startJobPolling() {
  clearInterval(jobTimer);
  jobTimer = setInterval(refreshActiveJob, 2500);
  refreshActiveJob();
}
async function refreshActiveJob() {
  if (!activeJobId) return;
  const res = await sendRaw("job.status", { id: activeJobId });
  if (!res.ok || !res.result.job) return;
  const job = res.result.job;
  // Counts live in the stats row; here we just keep the banner COLOUR in sync with
  // the job status (onJobProgress owns the live text). null text = leave it alone.
  const stateByStatus = { running: "running", paused: "paused", stopped: "stopped", error: "error", completed: "idle" };
  setJobStatus(null, stateByStatus[job.status] || null);
  if (["completed", "error", "stopped"].includes(job.status)) clearInterval(jobTimer);
}
function sendRaw(action, input = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, input }, (response) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(response || { ok: false, error: "no response" });
    });
  });
}
// Presentation toggle (top-right): popup vs side panel. Both render this exact
// page, so they are full mirrors — the toggle only switches how it's shown.
// The side panel loads with ?ctx=side so we can highlight the current surface.
try {
  document.getElementById("appVersion").textContent = `v${chrome.runtime.getManifest().version}`;
} catch {
  // chrome.runtime unavailable (e.g. preview) — leave the badge empty.
}

const isSidePanel = new URLSearchParams(location.search).get("ctx") === "side";
if (!isSidePanel) document.body.classList.add("popup-mode"); // widen the popup; side panel stays fluid
for (const btn of els.seg.querySelectorAll(".seg-btn")) {
  btn.classList.toggle("active", (btn.dataset.mode === "side") === isSidePanel);
}
els.seg.addEventListener("click", async (event) => {
  const btn = event.target.closest(".seg-btn");
  if (!btn || btn.classList.contains("active")) return;
  if (btn.dataset.mode === "side") {
    try {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
      if (!isSidePanel) window.close(); // close the popup once the panel is open
    } catch {
      // Side panel API unavailable on this Chrome.
    }
  } else if (isSidePanel) {
    // Switch back to popup: close the side panel; the toolbar icon opens the popup.
    window.close();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action === "collection.update") onUpdate(message);
  if (message?.action === "search.update") onSearchUpdate(message);
  if (message?.action === "job.progress") onJobProgress(message.progress);
  if (message?.action === "collection.exported") flashAutoStatus(`Auto-downloaded ${message.filename}`);
  // Keep the open "remaining URLs" list live as the scrape drains it.
  if (message?.action === "job.progress" || message?.action === "collection.update") refreshPendingIfOpen();
});

function onJobProgress(p) {
  if (!p) return;
  // Track the one URL being visited now, so the URL list highlights exactly it
  // (and nothing when we're not on a listing). refreshPendingIfOpen re-renders.
  liveScrapingUrl = p.running && p.phase === "listing" ? p.currentUrl || "" : "";
  // NOTE: the four stat counters (found/queue/scraped/failed) are owned solely by
  // refreshSession() — the durable session snapshot — which polls every 4s while a
  // job runs. onJobProgress must NOT also write them: it carries run-scoped counts
  // (only URLs newly discovered this run), so writing here made the numbers flicker
  // back and forth against the cumulative snapshot values. We only drive the live
  // "now" line and the queue pulse here.
  // Any phase other than the pause clears the between-terms countdown so it can't
  // linger over real activity.
  if (p.phase !== "between-terms") stopBetweenTermsCountdown();
  const q = els.jobQueue.parentElement;
  if (q) q.classList.toggle("live", p.running && p.queue > 0);
  if (p.phase === "starting") setJobStatus("Starting…", "running");
  else if (p.phase === "search") setJobStatus(`Discovering “${p.term}” — page ${p.page}…`, "running");
  else if (p.phase === "visiting") setJobStatus(p.term ? `Discovery done — visiting “${p.term}” listings…` : "Discovery done — visiting collected listings…", "running");
  else if (p.phase === "between-terms") startBetweenTermsCountdown(p.term, p.gapUntil);
  else if (p.phase === "listing") setJobStatus(`Visiting a “${p.term}” listing…`, "running");
  else if (p.phase === "done" || p.phase === "error") {
    const stopped = p.status === "stopped";
    const errored = p.status === "error";
    setJobStatus(
      stopped ? "Stopped." : errored ? "Stopped after repeated failures." : "Batch complete — idle.",
      stopped ? "stopped" : errored ? "error" : "idle",
    );
    refreshSession();
  }
}

init();

async function init() {
  const stats = await send("collection.stats");
  total = stats.total || 0;
  settings = stats.settings || settings;
  els.total.textContent = total.toLocaleString();
  els.demand.textContent = (stats.withDemand || 0).toLocaleString();
  els.autoEvery.value = settings.autoExportEvery || 500;
  els.downloadSubfolder.value = settings.downloadSubfolder || "";
  // The interval (seconds between each listing visit); stored in minutes, 30s floor.
  els.intervalInput.value = Math.max(30, Math.round((Number(settings.searchIntervalMin) || 0.5) * 60));
  els.betweenTermsInput.value = Math.max(0, Math.round((Number(settings.betweenTermsSec) || 0) / 60));
  els.randomizeToggle.checked = settings.randomizeInterval === true;
  els.randomizePct.value = settings.randomizePct ?? 40;
  els.manualFirstReviewToggle.checked = settings.manualFirstReview === true;
  els.autoExportToggle.checked = autoExportOn(settings);
  els.clearAfterExportToggle.checked = settings.clearAfterExport === true;
  els.autoRunToggle.checked = autoRunOn(settings);
  if (settings.queuePagesPerTerm) els.pagesInput.value = settings.queuePagesPerTerm;
  if (stats.jobProgress) onJobProgress(stats.jobProgress);
  renderAutoStatus();
  renderIntervalStatus();
  refreshSession();
}

function onUpdate({ total: t, withDemand, isNew, item }) {
  total = t;
  els.total.textContent = total.toLocaleString();
  els.totalCard.classList.remove("flash");
  void els.totalCard.offsetWidth;
  els.totalCard.classList.add("flash");
  // "With demand" is now authoritative from the background (survives clears); fall
  // back to the old local +1 only for legacy broadcasts that don't carry the count.
  if (typeof withDemand === "number") {
    els.demand.textContent = withDemand.toLocaleString();
  } else if (isNew && (item?.demandValue > 0 || item?.demandText)) {
    els.demand.textContent = (Number(els.demand.textContent.replace(/,/g, "")) + 1).toLocaleString();
  }
  prependFeed(item, isNew);
  renderAutoStatus();
}

function onSearchUpdate({ item }) {
  // The all-time "cards seen" header metric was removed — this now only streams the
  // live capture into the feed. The search_results store + Export search CSV are intact.
  if (!item) return;
  els.feedEmpty.hidden = true;
  const li = document.createElement("li");
  li.className = "enter";
  if (item.at) li.title = `Captured ${item.at}`;
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  thumb.style.background = "#2563eb";
  const body = document.createElement("div");
  body.className = "body";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = `“${item.keyword}” — ${item.count} results (page ${item.page})`;
  const sub = document.createElement("div");
  sub.className = "sub";
  appendJoined(sub, [`top: ${item.title || ""}`, makeSpan("ts", timeLabel(item.at), item.at || "")]);
  body.append(title, sub);
  const tag = document.createElement("span");
  tag.className = "new";
  tag.style.background = "#dbeafe";
  tag.style.color = "#1e40af";
  tag.textContent = "search";
  li.append(thumb, body, tag);
  els.feed.prepend(li);
  while (els.feed.children.length > 50) els.feed.lastChild.remove();
}

function prependFeed(item, isNew) {
  if (!item) return;
  els.feedEmpty.hidden = true;
  const li = document.createElement("li");
  li.className = "enter";
  const thumb = document.createElement("div");
  thumb.className = `thumb${item.demandText ? "" : " none"}`;
  const body = document.createElement("div");
  body.className = "body";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = item.title || "Untitled";
  const sub = document.createElement("div");
  sub.className = "sub";
  const bits = [];
  if (item.demandText) bits.push(makeSpan("demand", item.demandText));
  if (item.isDigital === true) bits.push("Digital");
  if (item.isDigital === false) bits.push("Physical");
  bits.push(makeSpan("ts", timeLabel(item.at), item.at || ""));
  appendJoined(sub, bits);
  if (item.at) li.title = `Captured ${item.at}`;
  body.append(title, sub);
  const tag = document.createElement("span");
  tag.className = isNew ? "new" : "seen";
  tag.textContent = isNew ? "new" : "updated";
  li.append(thumb, body, tag);
  els.feed.prepend(li);
  while (els.feed.children.length > 50) els.feed.lastChild.remove();
}

async function saveAuto() {
  const every = Math.max(1, Number.parseInt(els.autoEvery.value, 10) || 500);
  els.autoEvery.value = every;
  settings = await send("settings.save", { settings: { autoExportEvery: every } });
  flashAutoStatus(`Saved — auto-download every ${every} new listings.`);
  setTimeout(renderAutoStatus, 1500);
}

function renderAutoStatus() {
  const on = autoExportOn(settings);
  els.autoExportRow.classList.toggle("is-off", !on);
  if (!on) {
    els.autoStatus.textContent = "Off — listings still accumulate; export manually anytime.";
    return;
  }
  const remaining = untilNextExport(total, settings);
  els.autoStatus.textContent = `${remaining} more until the next auto-download.`;
}

function flashAutoStatus(text) {
  els.autoStatus.textContent = text;
}

function timeLabel(at) {
  if (!at) return "just now";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "just now";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// HTML-escape a value for the few remaining innerHTML templates (the term pills, which
// render the user's OWN typed search terms — not scraped data).
function escapeText(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Build a <span> with safe text/title — no innerHTML, so scraped/imported strings can
// never be parsed as markup.
function makeSpan(className, text, title) {
  const s = document.createElement("span");
  s.className = className;
  if (title != null) s.title = String(title);
  s.textContent = String(text ?? "");
  return s;
}

// Append parts joined by `sep`; each part is a plain string (→ text node) or a DOM node.
function appendJoined(parent, parts, sep = " · ") {
  parts.forEach((part, i) => {
    if (i > 0) parent.appendChild(document.createTextNode(sep));
    parent.appendChild(typeof part === "string" ? document.createTextNode(part) : part);
  });
}

function send(action, input = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, input }, (response) => {
      if (chrome.runtime.lastError) return resolve({});
      resolve(response?.result ?? {});
    });
  });
}
