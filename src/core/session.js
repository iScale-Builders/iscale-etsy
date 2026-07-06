// Durable session observability — aggregate the raw IndexedDB records (queued
// terms, discovered listing URLs + their status, jobs) into a snapshot the
// dashboard can show. Read from the stores, not from ephemeral in-memory state,
// so it survives closing/reopening and service-worker restarts.

function blankStat() {
  return { found: 0, done: 0, failed: 0, pending: 0, processing: 0 };
}

// One listing_urls row folded into a session tally. Extracted so callers can
// stream the store through storage.js reduceRecords instead of materializing
// every row (sessionStatus used to getAllRecords an unbounded store on a 4s
// poll). Same single-pass pattern as collectionStats. Pure and unit-tested
// for parity with the array path.
export function blankSessionTally() {
  return { totals: blankStat(), byTerm: new Map() };
}

export function foldSessionUrl(acc, u) {
  if (u.status === "removed") return acc; // user-deleted tombstone — not counted anywhere
  // A URL can belong to several terms (terms[] multiEntry); fall back to the legacy scalar
  // for pre-migration rows. Matches buildQueueView's termsOf so pill counts == queue counts.
  const termList = u.terms?.length ? u.terms : [u.searchTerm || u.term || ""];
  const bump = (s, status) => {
    s.found += 1;
    if (status === "done") s.done += 1;
    else if (status === "failed") s.failed += 1;
    else if (status === "processing") s.processing += 1;
    else s.pending += 1;
  };
  bump(acc.totals, u.status); // rollup counts each URL ONCE (no double-count for shared URLs)
  // Per-term: credit EVERY term that discovered this URL, so a term's pill count reflects
  // all its URLs — not just the ones whose first-seen scalar searchTerm happens to be it.
  // That mismatch left a currently-running term's pill blank. (audit deep-pass Med #6)
  for (const term of termList) {
    if (!acc.byTerm.has(term)) acc.byTerm.set(term, blankStat());
    bump(acc.byTerm.get(term), u.status);
  }
  return acc;
}

export function aggregateSession({ terms = [], listingUrls = [], urlTally = null, jobs = [], listingsTotal = 0, searchResultsTotal = 0 } = {}) {
  // Accept either raw rows (legacy/tests) or a pre-folded tally from a cursor pass.
  const tally = urlTally || listingUrls.reduce(foldSessionUrl, blankSessionTally());
  const { totals, byTerm } = tally;

  const activeJob =
    jobs.find((j) => j.status === "running") ||
    [...jobs].sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))[0] ||
    null;
  const searchDone = new Set(activeJob?.searchDone || []);

  const pagesFor = (term) => [...searchDone].filter((k) => k.startsWith(`${term}|`)).length;
  const termRows = terms.map((t) => ({
    id: t.id,
    term: t.term,
    lastRunAt: t.lastRunAt || "",
    pagesSearched: pagesFor(t.term),
    ...(byTerm.get(t.term) || blankStat()),
  }));

  // Surface terms from a currently-RUNNING job even if they were never written to
  // the queue (e.g. a legacy job resumed after an upgrade) so they're still visible.
  // ONLY while running — for a completed/most-recent job these would re-appear as
  // un-removable `job:` pills (the X / Clear queue can't delete a term that isn't
  // actually queued), which looked like "remove does nothing". (bug, 2026-06-26)
  const known = new Set(terms.map((t) => t.term));
  const runningJobTerms = activeJob?.status === "running" ? activeJob.terms || [] : [];
  for (const term of runningJobTerms) {
    if (known.has(term)) continue;
    known.add(term);
    termRows.push({ id: `job:${term}`, term, lastRunAt: "", running: true, pagesSearched: pagesFor(term), ...(byTerm.get(term) || blankStat()) });
  }

  return {
    terms: termRows,
    totals,
    listingsTotal,
    searchResultsTotal,
    activeJob: activeJob ? { id: activeJob.id, status: activeJob.status, startedAt: activeJob.startedAt || "", pagesDone: searchDone.size } : null,
  };
}
