import { makeExportFilename, rowsToCsv } from "./src/core/csv.js";
import { mergeImportedListings, rowsFromImportedCsv } from "./src/core/import-listings.js";
import { getAllRecords, bulkPut, clearStore, deleteRecord } from "./src/core/storage.js";
import { withListingsLock } from "./src/core/locks.js";
import { SHOP_PAGE_SIZE, formatRelativeTime, formatReviewDate, getDemandIndicators, prepareShopRows, queryPrepared } from "./src/core/shop-sort.js";

let rawListings = [];
let preparedRows = []; // normalized + deduped once; reused across filter/sort/page changes
let sortDir = "desc";
let chip = "all";
let page = 1;
let cycleTimer = null;

const els = {
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  empty: document.getElementById("empty"),
  brandCount: document.getElementById("brandCount"),
  updatedAt: document.getElementById("updatedAt"),
  showing: document.getElementById("showing"),
  search: document.getElementById("search"),
  searchGo: document.getElementById("searchGo"),
  suggest: document.getElementById("suggest"),
  suggestSubmit: document.getElementById("suggestSubmit"),
  sort: document.getElementById("sort"),
  sortDir: document.getElementById("sortDir"),
  demandFilter: document.getElementById("demandFilter"),
  chips: document.getElementById("chips"),
  importCsv: document.getElementById("importCsv"),
  exportCsv: document.getElementById("exportCsv"),
  clearListings: document.getElementById("clearListings"),
  pagination: document.getElementById("pagination"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  pageInfo: document.getElementById("pageInfo"),
};

els.search.addEventListener("input", debounce(resetAndRender, 250));
els.searchGo.addEventListener("click", resetAndRender);
els.demandFilter.addEventListener("input", debounce(resetAndRender, 250));
els.sort.addEventListener("change", resetAndRender);
els.suggestSubmit.addEventListener("click", submitSuggested);
els.suggest.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitSuggested();
});
els.sortDir.addEventListener("click", () => {
  sortDir = sortDir === "desc" ? "asc" : "desc";
  els.sortDir.textContent = sortDir === "desc" ? "↓" : "↑";
  els.sortDir.classList.toggle("asc", sortDir === "asc");
  resetAndRender();
});
els.chips.addEventListener("click", (event) => {
  const btn = event.target.closest(".chip");
  if (!btn) return;
  chip = btn.dataset.chip;
  for (const c of els.chips.querySelectorAll(".chip")) c.classList.toggle("active", c === btn);
  resetAndRender();
});
els.prevBtn.addEventListener("click", () => {
  page -= 1;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
});
els.nextBtn.addEventListener("click", () => {
  page += 1;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
});
els.importCsv.addEventListener("change", importCsvFiles);
els.exportCsv.addEventListener("click", exportCsv);
els.clearListings.addEventListener("click", clearListings);
els.grid.addEventListener("click", onGridClick);

try {
  document.getElementById("appVersion").textContent = `v${chrome.runtime.getManifest().version}`;
} catch {
  // chrome.runtime unavailable (e.g. preview) — leave the badge empty.
}

load();

async function load() {
  try {
    rawListings = await getAllRecords("listings");
    els.status.textContent = rawListings.length ? "" : "No stored listings yet. Scrape Etsy pages or import a CSV.";
  } catch {
    rawListings = [];
    els.status.textContent = "Stored listings unavailable here — import a CSV to populate the shop.";
  }
  preparedRows = prepareShopRows(rawListings);
  render();
}

function resetAndRender() {
  page = 1;
  render();
}

function render() {
  const result = queryPrepared(preparedRows, {
    search: els.search.value,
    demand: els.demandFilter.value,
    chip,
    sort: els.sort.value,
    dir: sortDir,
    page,
    pageSize: SHOP_PAGE_SIZE,
  });
  page = result.page;

  els.brandCount.textContent = (result.grandTotal || 0).toLocaleString();
  els.updatedAt.textContent = relativeUpdated();
  els.showing.innerHTML = result.total
    ? `Showing <b>${result.rangeStart.toLocaleString()}–${result.rangeEnd.toLocaleString()}</b> of <b>${result.total.toLocaleString()}</b> products`
    : "No products yet";

  els.empty.hidden = result.pageRows.length > 0;
  els.grid.innerHTML = result.pageRows.map((row, i) => card(row, chip, i)).join("");
  // Swap any thumbnail that fails to load (404 / hotlink-blocked Etsy URL) to the same
  // placeholder, so a dead image shows a clean tile instead of the browser's broken-image
  // icon. CSP forbids inline onerror, so we attach the handler here.
  for (const im of els.grid.querySelectorAll("img.product-image")) {
    im.addEventListener(
      "error",
      () => {
        const ph = document.createElement("div");
        ph.className = "product-image product-image--ph";
        ph.innerHTML = ICON.noImage; // trusted constant
        im.replaceWith(ph);
      },
      { once: true },
    );
  }

  els.pagination.hidden = result.totalPages <= 1;
  els.pageInfo.textContent = `Page ${result.page} of ${result.totalPages.toLocaleString()}`;
  els.prevBtn.disabled = result.page <= 1;
  els.nextBtn.disabled = result.page >= result.totalPages;

  startCycling();
}

// Add the suggested term(s) to the shared search queue (same queue the
// dashboard drives). Accepts comma- or newline-separated terms; the backend
// splits, trims, dedupes, and validates them via parseSearchTerms.
async function submitSuggested() {
  const value = els.suggest.value.trim();
  if (!value) return;
  const res = await sendRaw("terms.add", { terms: value });
  if (!res.ok) {
    els.status.textContent = "Couldn't add to the search queue here — open the dashboard to queue terms.";
    return;
  }
  const added = res.result?.added || 0;
  els.suggest.value = "";
  els.status.textContent = added
    ? `Added ${added} term${added === 1 ? "" : "s"} to the search queue.`
    : "Already in the search queue.";
}

function sendRaw(action, input = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action, input }, (response) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(response || { ok: false, error: "no response" });
      });
    } catch (err) {
      resolve({ ok: false, error: String(err) });
    }
  });
}

function relativeUpdated() {
  let newest = 0;
  for (const row of rawListings) {
    const t = Date.parse(row.lastScrapedAt || row.scrapedAt || row.lastSeenAt || "");
    if (!Number.isNaN(t) && t > newest) newest = t;
  }
  return newest ? formatRelativeTime(new Date(newest).toISOString()) : "Just now";
}

function card(row, filter, index) {
  const indicators = getDemandIndicators(row, filter);
  const hasMultiple = indicators.length > 1;
  const img = safeImageUrl(row.imageUrl);
  const delay = Math.min(index * 35, 600);
  return `
    <div class="product-card${row.deleted ? " unavailable" : ""}" style="animation-delay:${delay}ms">
      <a class="card-link" href="${safeHref(row.url)}" target="_blank" rel="noopener" aria-label="${escapeHtml(row.title)}"></a>
      <div class="product-image-container">
        ${row.deleted ? `<div class="unavailable-badge">No longer available</div>` : ""}
        ${img ? `<img class="product-image" src="${img}" alt="${escapeHtml(row.title)}" loading="lazy" />` : `<div class="product-image product-image--ph">${ICON.noImage}</div>`}
        ${demandBadge(indicators, hasMultiple)}
        ${typeBadge(row.isDigital)}
        ${img ? `<button class="download-btn" data-img="${img}" data-title="${escapeHtml(row.title)}" title="Download image" type="button">${ICON.download}</button>` : ""}
      </div>
      <div class="product-info">
        <div class="product-title">${escapeHtml(row.title)}</div>
        <div class="product-price"><span class="lbl">Price:</span> ${escapeHtml(row.price || "N/A")}</div>
        <div class="product-meta">
          ${row.favorites ? `<span class="product-favorites">${ICON.heart}${escapeHtml(row.favorites.toLocaleString())}</span>` : ""}
          ${row.reviewCount ? `<span class="product-reviews">${ICON.star}${escapeHtml(row.reviewCount.toLocaleString())}</span>` : ""}
          ${firstReviewBadge(row.firstReview)}
        </div>
        ${hasMultiple ? `<div class="demand-dots">${indicators.map((_, i) => `<div class="demand-dot ${i === 0 ? "active" : ""}"></div>`).join("")}</div>` : ""}
      </div>
    </div>`;
}

function typeBadge(isDigital) {
  if (isDigital === true) return `<div class="type-badge digital" title="Digital download">${ICON.download}</div>`;
  if (isDigital === false) return `<div class="type-badge physical" title="Physical product">${ICON.box}</div>`;
  return "";
}

function demandBadge(indicators, hasMultiple) {
  if (indicators.length === 0) return "";
  const first = indicators[0];
  return `<div class="demand-badge${hasMultiple ? " cycling" : ""}" data-indicators="${escapeHtml(JSON.stringify(indicators))}" data-index="0">
      <span class="demand-text">${escapeHtml(first.info)}</span>
      <span class="demand-time">${escapeHtml(formatRelativeTime(first.timestamp))}</span>
    </div>`;
}

function firstReviewBadge(value) {
  if (!value || value === "N/A" || value === "None") return "";
  return `<span class="product-first-review">${ICON.clock}1st Review: ${escapeHtml(formatReviewDate(value))}</span>`;
}

function startCycling() {
  if (cycleTimer) clearInterval(cycleTimer);
  const badges = [...els.grid.querySelectorAll(".demand-badge.cycling")];
  if (badges.length === 0) return;
  cycleTimer = setInterval(() => {
    for (const badge of badges) {
      let indicators;
      try {
        indicators = JSON.parse(badge.getAttribute("data-indicators"));
      } catch {
        continue;
      }
      if (!Array.isArray(indicators) || indicators.length < 2) continue;
      const next = (Number(badge.getAttribute("data-index")) + 1) % indicators.length;
      const textEl = badge.querySelector(".demand-text");
      const timeEl = badge.querySelector(".demand-time");
      textEl.classList.add("fading");
      timeEl.classList.add("fading");
      setTimeout(() => {
        textEl.textContent = indicators[next].info;
        timeEl.textContent = formatRelativeTime(indicators[next].timestamp);
        textEl.classList.remove("fading");
        timeEl.classList.remove("fading");
        badge.setAttribute("data-index", String(next));
        const dots = badge.closest(".product-card").querySelectorAll(".demand-dot");
        dots.forEach((dot, i) => dot.classList.toggle("active", i === next));
      }, 300);
    }
  }, 4000);
}

function onGridClick(event) {
  const btn = event.target.closest(".download-btn");
  if (!btn) return;
  // Stop the card link from opening; route the download through the background's
  // chrome.downloads API so cross-origin Etsy CDN images actually download.
  event.preventDefault();
  event.stopPropagation();
  const img = btn.getAttribute("data-img");
  if (!img) return;
  try {
    chrome.runtime.sendMessage({ action: "image.download", input: { url: img, title: btn.getAttribute("data-title") } });
  } catch {
    window.open(img, "_blank", "noopener");
  }
}

async function importCsvFiles(event) {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) return;
  els.status.textContent = `Importing ${files.length} file${files.length === 1 ? "" : "s"}…`;
  const importedAt = new Date().toISOString();
  const importedRows = [];
  for (const file of files) {
    importedRows.push(...rowsFromImportedCsv(await file.text(), importedAt));
  }
  // EXCLUSIVE listings lock for the whole read→merge→write so a concurrent SW save in the
  // other context can't be overwritten by our stale-snapshot bulkPut. (audit deep-pass #16)
  const merged = await withListingsLock("exclusive", async () => {
    const existing = await getAllRecords("listings");
    const m = mergeImportedListings(existing, importedRows);
    await bulkPut("listings", m.rows);
    // Delete any orphan rows collapsed into a canonical id (same URL, different primary
    // key) so they don't linger in the store and inflate counts. (audit M-1)
    for (const id of m.removedIds || []) await deleteRecord("listings", id);
    return m;
  });
  rawListings = merged.rows;
  preparedRows = prepareShopRows(rawListings);
  // We wrote `listings` directly (bypassing the service worker), so its in-memory
  // counters/badge are now stale — ask it to re-seed from the store.
  sendRaw("collection.refresh").catch(() => {});
  els.status.textContent = `Imported ${merged.imported} rows (${merged.added} new, ${merged.updated} merged).`;
  event.target.value = "";
  resetAndRender();
}

function exportCsv() {
  const csv = rowsToCsv(rawListings);
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = makeExportFilename("etsy-shop-view");
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  els.status.textContent = `Exported ${rawListings.length} listing${rawListings.length === 1 ? "" : "s"}.`;
}

async function clearListings() {
  if (!rawListings.length) {
    els.status.textContent = "Nothing to clear.";
    return;
  }
  const ok = window.confirm(
    `Delete ALL ${rawListings.length} collected listing${rawListings.length === 1 ? "" : "s"}? This wipes your research collection. Your search terms and queue are kept. This cannot be undone — export a CSV first if you want a copy.`,
  );
  if (!ok) return;
  // Route through the service worker so its in-memory counters/badge reset too (the
  // same handler the dashboard's Clear uses). Falls back to a direct store clear if the
  // SW is unreachable (e.g. opened standalone), so the button always works.
  const res = await sendRaw("collection.clear");
  if (!res.ok) {
    try {
      await withListingsLock("exclusive", () => clearStore("listings")); // exclude concurrent saves (deep-pass Med)
    } catch {
      els.status.textContent = "Could not clear listings.";
      return;
    }
  }
  rawListings = [];
  preparedRows = prepareShopRows(rawListings);
  page = 1;
  render();
  els.status.textContent = "Cleared all collected listings.";
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Only allow https links to Etsy — blocks javascript:/data: and imported-CSV
// phishing links to arbitrary hosts.
function safeHref(url) {
  try {
    const u = new URL(String(url ?? "").trim());
    if (u.protocol === "https:" && /(^|\.)etsy\.com$/i.test(u.hostname)) return escapeHtml(u.href);
  } catch {
    // not a valid URL
  }
  return "#";
}

// Only allow https images on Etsy's own CDN. `imageUrl` can arrive unvalidated
// from a CSV import; escapeHtml stops attribute breakout but not the scheme, so
// an odd-scheme value would otherwise reach `img src` AND the download-fallback
// `window.open(img)`. Returns "" (no image, no download button) when unsafe. (M-3)
function safeImageUrl(url) {
  try {
    const u = new URL(String(url ?? "").trim());
    if (u.protocol === "https:" && /(^|\.)(etsy\.com|etsystatic\.com)$/i.test(u.hostname)) {
      return escapeHtml(u.href);
    }
  } catch {
    // not a valid URL
  }
  return "";
}

const ICON = {
  heart: `<svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clip-rule="evenodd"/></svg>`,
  star: `<svg fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69z"/></svg>`,
  clock: `<svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd"/></svg>`,
  download: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>`,
  box: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>`,
  noImage: `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" d="M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zm0 11l5-5 4 4 3-3 4 4M9.5 9a1 1 0 11-2 0 1 1 0 012 0z"/></svg>`,
};
