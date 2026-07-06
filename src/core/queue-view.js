// Pure builder for the dashboard's "remaining URLs" + "failed" view from raw listing_urls
// rows. Extracted from the background message adapter so the term-grouping, active-term
// filtering, per-term counts, the display CAP, and multi-term fan-out are unit-testable
// (they were inlined in an anonymous adapter no test could reach). Tombstoned ("removed")
// rows are naturally excluded — they're not pending/processing/done/failed.
// (audit M-14 / ship-checklist #10)

const DEFAULT_CAP = 2000;

// A URL belongs to every term that surfaced it (terms[] multiEntry); fall back to the
// legacy scalar term for pre-migration rows.
function termsOf(u) {
  return u.terms?.length ? u.terms : [u.searchTerm || u.term || ""];
}

// Within a term, order by the search page found on (p1, then p2…), then URL — discovery
// order, not URL-alphabetical.
function sortUrls(out) {
  return out.sort(
    (a, b) =>
      String(a.term).localeCompare(String(b.term)) ||
      (Number(a.page) || 0) - (Number(b.page) || 0) ||
      String(a.url).localeCompare(String(b.url)),
  );
}

export function buildQueueView(rows = [], cap = DEFAULT_CAP) {
  const list = Array.isArray(rows) ? rows : [];

  // Terms that still have work (pending/processing) — ONLY these surface their already-
  // visited (done) rows, so a term's URLs flip to green page-by-page without a finished
  // term dumping thousands of done rows.
  const activeTerms = new Set();
  for (const u of list) {
    if (u.status === "pending" || u.status === "processing") {
      for (const t of termsOf(u)) activeTerms.add(t);
    }
  }

  const out = [];
  const counts = {}; // remaining (pending+processing) per term — the work left
  const doneCounts = {}; // already-visited per active term
  for (const u of list) {
    const visited = u.status === "done";
    if (u.status !== "pending" && u.status !== "processing" && !visited) continue;
    for (const t of termsOf(u)) {
      if (visited && !activeTerms.has(t)) continue;
      out.push({ url: u.url, term: t, status: u.status, page: u.page || null });
      if (visited) doneCounts[t] = (doneCounts[t] || 0) + 1;
      else counts[t] = (counts[t] || 0) + 1;
    }
  }
  sortUrls(out);
  const remainingTotal = Object.values(counts).reduce((a, b) => a + b, 0);
  const pending = { total: remainingTotal, capped: out.length > cap, counts, doneCounts, urls: out.slice(0, cap) };

  // Failed: its own block (gets a Retry button in the UI).
  const fout = [];
  const fcounts = {};
  for (const u of list) {
    if (u.status !== "failed") continue;
    for (const t of termsOf(u)) {
      fout.push({ url: u.url, term: t, status: u.status, page: u.page || null });
      fcounts[t] = (fcounts[t] || 0) + 1;
    }
  }
  sortUrls(fout);
  const failed = { total: fout.length, capped: fout.length > cap, counts: fcounts, urls: fout.slice(0, cap) };

  return { ...pending, failed };
}
