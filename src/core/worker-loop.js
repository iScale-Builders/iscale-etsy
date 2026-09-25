// One claimed Etsy search, driven by injected browser/backend adapters so the
// sequence can be tested without Chrome. Page 1 is typed into the search box.
// Each finished results page is uploaded before the next page starts.

import { buildSearchUrl } from "./etsy-url.js";
import { formatSearchPathLog } from "./search-box.js";

export function decideWorkerTick({ cfg, localRunnerBusy = false, nowMs = Date.now(), scanning = false } = {}) {
  if (scanning) return { action: "busy" };
  if (!cfg?.enabled) return { action: "disabled" };
  if (!cfg.ready) return { action: "incomplete_config", error: cfg.configError || "incomplete_config" };
  if ((Number(cfg.blockedUntil) || 0) > nowMs) return { action: "backoff" };
  if (localRunnerBusy) return { action: "deferred_local_job" };
  return { action: "claim" };
}

export function paceDelayMs(cfg = {}, rand = Math.random) {
  const min = Math.max(0, Number(cfg.paceMinMs) || 0);
  const max = Math.max(min, Number(cfg.paceMaxMs) || min);
  return min + Math.floor(rand() * (max - min + 1));
}

export function betweenJobsDelayMs(cfg = {}, rand = Math.random) {
  const min = Math.max(0, Number(cfg.betweenJobsMinMs) || 0);
  const max = Math.max(min, Number(cfg.betweenJobsMaxMs) || min);
  return min + Math.floor(rand() * (max - min + 1));
}

export const HOUR_MS = 60 * 60 * 1000;
export const UPLOAD_BATCH_SIZE = 300;

export function jobsWithinHour(timestamps, nowMs, windowMs = HOUR_MS) {
  const now = Number(nowMs) || 0;
  return (Array.isArray(timestamps) ? timestamps : []).filter((stamp) => {
    const at = Number(stamp);
    return Number.isFinite(at) && now - at < windowMs && now - at >= 0;
  });
}

export function hourlyCapReached(timestamps, nowMs, cap, windowMs = HOUR_MS) {
  const limit = Number(cap);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return jobsWithinHour(timestamps, nowMs, windowMs).length >= limit;
}

export function planDrainStep({ ranJob = false, claimTimes = [], nowMs = Date.now(), cap = 30, cfg = {}, rand = Math.random } = {}) {
  if (hourlyCapReached(claimTimes, nowMs, cap)) return { action: "hourly_cap" };
  if (ranJob) return { action: "pause", delayMs: betweenJobsDelayMs(cfg, rand) };
  return { action: "claim" };
}

export function chunkRows(rows, size = UPLOAD_BATCH_SIZE) {
  const list = Array.isArray(rows) ? rows : [];
  const limit = Math.max(1, Number(size) || UPLOAD_BATCH_SIZE);
  if (list.length === 0) return [[]];
  const chunks = [];
  for (let i = 0; i < list.length; i += limit) chunks.push(list.slice(i, i + limit));
  return chunks;
}

export function isRetryableUploadFailure(result) {
  if (!result || result.ok) return false;
  if (result.network === true) return true;
  const status = Number(result.status);
  if (status === 408 || status === 429) return true;
  return status >= 500 && status <= 599;
}

export async function uploadWithBackoff(send, body, { sleep = async () => {}, attempts = 4 } = {}) {
  let last = null;
  const tries = Math.max(1, Number(attempts) || 1);
  for (let i = 0; i < tries; i += 1) {
    try {
      last = await send(body);
    } catch (error) {
      last = { ok: false, network: true, error: String(error?.message || error || "network_error") };
    }
    if (last?.ok || !isRetryableUploadFailure(last)) return last || { ok: false, error: "upload_failed" };
    if (i < tries - 1) await sleep(Math.min(8000, 500 * 2 ** i));
  }
  return last || { ok: false, error: "upload_failed" };
}

export async function deliverListings(deps, body) {
  const { listings, ...rest } = body || {};
  const chunks = chunkRows(listings);
  let last = null;
  for (const chunk of chunks) {
    last = await uploadWithBackoff((part) => deps.upload(part), { ...rest, listings: chunk }, { sleep: deps.sleep });
    if (!last?.ok) return last;
  }
  return last || { ok: false, error: "upload_failed" };
}

export function interpretBlockReply(response) {
  if (!response || response.error || !response.block || typeof response.block.blocked !== "boolean") {
    return { blocked: true, reason: "unknown", noResults: false };
  }
  return {
    blocked: response.block.blocked === true,
    reason: response.block.reason || null,
    noResults: response.block.noResults === true,
  };
}

export function workerTabReusable(tab, localRunnerTabId) {
  if (!tab || tab.id == null) return false;
  if (localRunnerTabId != null && tab.id === localRunnerTabId) return false;
  const url = tab.url || tab.pendingUrl || "";
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && /(^|\.)etsy\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

export function suspiciousEmptySearch(extracted) {
  if (extracted?.block?.blocked) return false;
  const results = extracted?.payload?.results || [];
  if (results.length > 0) return false;
  if (extracted?.block?.noResults === true || extracted?.payload?.noResults === true) return false;
  return true;
}

export function listingRowsForUpload(payload) {
  const scrapedAt = payload?.capturedAt || new Date().toISOString();
  return (payload?.results || [])
    .map((row) => ({
      listing_id: String(row?.listingId || ""),
      title: row?.title || "",
      shop_name: row?.shopName || "",
      price: row?.price || "",
      price_numeric: row?.priceNumeric ?? null,
      currency: row?.currency || null,
      favorites: row?.favorites ?? null,
      review_count: row?.reviewCount ?? null,
      rating: row?.rating ?? null,
      sales_signal: row?.salesSignal || null,
      is_bestseller: row?.isBestseller === true,
      is_popular: row?.isPopular === true,
      is_ad: row?.isAd === true,
      tags: Array.isArray(row?.tags) ? row.tags : [],
      image_url: row?.imageUrl || "",
      listing_url: row?.url || "",
      position: row?.position,
      page: row?.page,
      scraped_at: row?.capturedAt || scrapedAt,
    }))
    .filter((row) => /^\d{7,12}$/.test(row.listing_id));
}

function snapshot(base, extra) {
  return { laneName: base.laneName, backendHost: base.origin, ...extra };
}

async function notePath(deps, sessionBase, entry) {
  const line = formatSearchPathLog(entry);
  await deps.log?.(line, entry);
  await deps.writeSession?.(snapshot(sessionBase, { searchPath: entry?.path || "", phase: entry?.path || "search" }));
  return entry;
}

export async function runClaimedSearch({ job, cfg, deps }) {
  const sessionBase = { laneName: cfg.laneName, origin: cfg.origin };
  const pages = Math.max(1, Number(job?.pages) || 1);
  const sort = job?.sort || "most_relevant";
  const term = job?.term;
  let totalResults = null;
  let totalResultsRaw = null;
  let listingsUploaded = 0;
  let searchPath = "";

  if (!job?.id || !term) return { status: "failed", error: "invalid_job" };

  await deps.writeSession?.(snapshot(sessionBase, {
    status: "running",
    phase: "opening",
    jobId: job.id,
    term,
    page: 0,
    pages,
    listingsUploaded: 0,
    totalResults: null,
    lastError: "",
  }));
  await deps.openHome?.();

  if (deps.isCancelled?.()) return { status: "cancelled" };

  await deps.writeSession?.(snapshot(sessionBase, { status: "running", phase: "typing", jobId: job.id, term, page: 1, pages }));
  const typed = await deps.typeAndSubmit(term);
  if (typed?.ok && typed.path === "search_box") {
    searchPath = "search_box";
    await notePath(deps, sessionBase, typed);
    const landed = await deps.waitForSearch(term);
    if (!landed) {
      searchPath = "url_navigation";
      await notePath(deps, sessionBase, { path: "url_navigation", reason: "submit_did_not_navigate" });
      await deps.navigate(buildSearchUrl(term, 1, sort));
    }
  } else {
    searchPath = "url_navigation";
    await notePath(deps, sessionBase, {
      path: "url_navigation",
      reason: typed?.reason || typed?.error || "search_box_not_found",
    });
    await deps.navigate(buildSearchUrl(term, 1, sort));
  }

  for (let page = 1; page <= pages; page += 1) {
    if (deps.isCancelled?.()) return { status: "cancelled", page, listingsUploaded, totalResults };

    if (page > 1) {
      const next = await deps.clickNext(page - 1);
      if (next?.ok && next.path === "pagination_click") {
        searchPath = "pagination_click";
        await notePath(deps, sessionBase, next);
        const landed = await deps.waitForNavigation();
        if (!landed) {
          searchPath = "url_navigation";
          await notePath(deps, sessionBase, { path: "url_navigation", reason: "pagination_click_timeout" });
          await deps.navigate(buildSearchUrl(term, page, sort));
        }
      } else {
        searchPath = "url_navigation";
        await notePath(deps, sessionBase, {
          path: "url_navigation",
          reason: next?.reason || "next_page_not_found",
        });
        await deps.navigate(buildSearchUrl(term, page, sort));
      }
    }

    await deps.heartbeat?.({
      jobId: job.id,
      page,
      pages,
      listingsUploaded,
      totalResults,
      search_path: searchPath,
      phase: "search",
    });
    await deps.writeSession?.(snapshot(sessionBase, {
      status: "running",
      phase: "search",
      jobId: job.id,
      term,
      page,
      pages,
      searchPath,
      listingsUploaded,
      totalResults,
    }));

    let extracted = await deps.extractPage();
    if (!extracted?.payload && !extracted?.block?.blocked) {
      extracted = await deps.extractPage();
    }
    if (extracted?.block?.blocked || suspiciousEmptySearch(extracted)) {
      const reason = extracted?.block?.blocked ? extracted.block.reason || "captcha" : "suspicious_empty";
      await deps.fail?.({ jobId: job.id, blocked: true, error: `${reason}:page:${page}` });
      await deps.writeSession?.(snapshot(sessionBase, {
        status: "blocked",
        phase: "captcha",
        jobId: job.id,
        term,
        page,
        pages,
        searchPath,
        lastError: reason,
        totalResults,
        listingsUploaded,
      }));
      return { status: "blocked", reason, page, listingsUploaded, totalResults };
    }

    const payload = extracted?.payload || { results: [], totalResults: null };
    if (payload.totalResults != null) totalResults = payload.totalResults;
    if (payload.totalResultsRaw) totalResultsRaw = payload.totalResultsRaw;
    const listings = listingRowsForUpload(payload);
    await deps.writeSession?.(snapshot(sessionBase, {
      status: "uploading",
      phase: "upload",
      jobId: job.id,
      term,
      page,
      pages,
      searchPath,
      totalResults,
      listingsUploaded,
    }));

    const uploaded = await deliverListings(deps, {
      jobId: job.id,
      page,
      listings,
      totalResults,
      totalResultsRaw,
      searchPath,
    });
    if (!uploaded?.ok) {
      if (uploaded?.error === "already_completed") {
        return { status: "completed", already: true, page, listingsUploaded, totalResults };
      }
      const error = uploaded?.error || "upload_failed";
      if (error === "lease_lost") {
        await deps.writeSession?.(snapshot(sessionBase, {
          status: "error",
          phase: "lease_lost",
          jobId: job.id,
          term,
          page,
          lastError: "lease_lost",
        }));
        return { status: "lease_lost", page, listingsUploaded, totalResults };
      }
      await deps.fail?.({ jobId: job.id, blocked: false, error, retryable: isRetryableUploadFailure(uploaded) });
      await deps.writeSession?.(snapshot(sessionBase, {
        status: "error",
        phase: "upload",
        jobId: job.id,
        term,
        page,
        lastError: error,
      }));
      return { status: "failed", error, page, listingsUploaded, totalResults };
    }

    listingsUploaded = uploaded.listings_uploaded ?? listingsUploaded + listings.length;
    await deps.heartbeat?.({
      jobId: job.id,
      page,
      pages,
      listingsUploaded,
      totalResults,
      search_path: searchPath,
      phase: "uploaded",
    });
    await deps.writeSession?.(snapshot(sessionBase, {
      status: "running",
      phase: "uploaded",
      jobId: job.id,
      term,
      page,
      pages,
      searchPath,
      listingsUploaded,
      totalResults,
    }));

    if (page < pages) await deps.sleep?.(paceDelayMs(cfg, deps.rand));
  }

  const done = await deps.complete?.({
    jobId: job.id,
    pagesDone: pages,
    listingsUploaded,
    totalResults,
    search_path: searchPath,
    phase: "done",
  });
  if (done && done.ok === false) {
    await deps.writeSession?.(snapshot(sessionBase, {
      status: "error",
      phase: "complete",
      jobId: job.id,
      term,
      lastError: done.error || "complete_failed",
      listingsUploaded,
      totalResults,
    }));
    return { status: "failed", error: done.error || "complete_failed", listingsUploaded, totalResults };
  }

  await deps.writeSession?.(snapshot(sessionBase, {
    status: "idle",
    phase: "done",
    jobId: job.id,
    term,
    page: pages,
    pages,
    searchPath,
    listingsUploaded,
    totalResults,
    lastError: "",
  }));
  return { status: "completed", listingsUploaded, totalResults, searchPath };
}
