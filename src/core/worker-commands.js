// Typed command channel for the optional worker lane.
// Search keeps the existing typed-search flow. The other types reuse the
// extension's listing extract, shop-page capture, Shop View query, and CSV
// export. Executors talk to the browser only through injected deps.

import { rowsToCsv, makeExportFilename, DEFAULT_EXPORT_COLUMNS } from "./csv.js";
import { canonicalListingUrl } from "./etsy-url.js";
import { SEARCH_EXPORT_COLUMNS } from "./search-results.js";
import { SHOP_CHIPS, SHOP_SORTS, queryShop } from "./shop-sort.js";
import { buildShopUrl } from "./shop-page.js";
import { deliverListings, isRetryableUploadFailure, listingRowsForUpload, paceDelayMs, runClaimedSearch, uploadWithBackoff } from "./worker-loop.js";

export const JOB_TYPES = ["search", "scrape-listings", "scrape-shop", "export", "collection-stats"];
export const MAX_LISTING_URLS = 40;
export const MAX_SHOP_PAGES = 10;
export const MAX_SHOP_VISITS = 15;
export const MAX_EXPORT_ROWS = 500;
export const EXPORT_SOURCES = ["listings", "search", "shop"];
export const EXPORT_FORMATS = ["csv", "json"];

const SHOP_CHIP_SET = new Set(SHOP_CHIPS);
const SHOP_SORT_SET = new Set(SHOP_SORTS);

export function jobTypeOf(job) {
  const type = String(job?.job_type || job?.type || "search").trim().toLowerCase();
  return type || "search";
}

export function jobParams(job) {
  const raw = job?.params;
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  return {};
}

export function normalizeListingUrls(values) {
  const collected = collectListingUrls(values);
  return collected.urls || [];
}

export function collectListingUrls(values) {
  const seen = new Set();
  const urls = [];
  const list = Array.isArray(values) ? values : [values];
  for (const value of list) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    const url = canonicalListingUrl(text);
    if (!url) return { error: "invalid_listing_url" };
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  if (urls.length === 0) return { error: "invalid_listing_url" };
  if (urls.length > MAX_LISTING_URLS) return { error: "too_many_urls" };
  return { urls };
}

export function normalizeExportParams(input = {}) {
  const source = String(input.source || "listings").trim().toLowerCase();
  const format = String(input.format || "csv").trim().toLowerCase();
  if (!EXPORT_SOURCES.includes(source)) return { error: "invalid_source" };
  if (!EXPORT_FORMATS.includes(format)) return { error: "invalid_format" };
  const chip = String(input.chip || "all").trim().toLowerCase();
  const sort = String(input.sort || "newest").trim().toLowerCase();
  const dir = String(input.dir || "desc").trim().toLowerCase() === "asc" ? "asc" : "desc";
  return {
    source,
    format,
    q: String(input.q || input.search || "").trim().slice(0, 200),
    demand: String(input.demand || "").trim().slice(0, 200),
    chip: SHOP_CHIP_SET.has(chip) ? chip : "all",
    sort: SHOP_SORT_SET.has(sort) ? sort : "newest",
    dir,
  };
}

export function listingDetailRow(listing, position, page = 1) {
  const listingId = String(listing?.listingId || "");
  return {
    listing_id: listingId,
    title: listing?.title || "",
    shop_name: listing?.shopName || "",
    price: listing?.price || "",
    price_numeric: listing?.priceNumeric ?? null,
    currency: listing?.currency || null,
    favorites: listing?.favorites ?? null,
    review_count: listing?.reviewCount ?? null,
    image_url: listing?.imageUrl || "",
    listing_url: listing?.url || listing?.normalizedUrl || (listingId ? `https://www.etsy.com/listing/${listingId}` : ""),
    position,
    page,
    tags: [],
    is_bestseller: false,
    is_popular: false,
    is_ad: false,
    scraped_at: listing?.scrapedAt || new Date().toISOString(),
  };
}

export function listingDetailPayload(listing) {
  return {
    listingId: listing?.listingId || "",
    title: listing?.title || "",
    url: listing?.url || listing?.normalizedUrl || "",
    price: listing?.price || "",
    priceNumeric: listing?.priceNumeric ?? null,
    currency: listing?.currency || "",
    shopName: listing?.shopName || "",
    imageUrl: listing?.imageUrl || "",
    favorites: listing?.favorites ?? null,
    reviewCount: listing?.reviewCount ?? null,
    firstReview: listing?.firstReview || "",
    lastReview: listing?.lastReview || "",
    demandText: listing?.demandText || "",
    demandType: listing?.demandType || "",
    demandValue: listing?.demandValue ?? null,
    hasDemandIndicator: listing?.hasDemandIndicator === true,
    isDigital: listing?.isDigital ?? null,
    scrapedAt: listing?.scrapedAt || "",
  };
}

export function shapeExport(rows, params = {}, now = new Date()) {
  const normalized = normalizeExportParams(params);
  if (normalized.error) return { error: normalized.error };
  const all = Array.isArray(rows) ? rows : [];
  let view = all;
  let total = all.length;
  if (normalized.source === "shop") {
    const queried = queryShop(all, {
      search: normalized.q,
      demand: normalized.demand,
      chip: normalized.chip,
      sort: normalized.sort,
      dir: normalized.dir,
      page: 1,
      pageSize: MAX_EXPORT_ROWS,
    });
    view = queried.pageRows;
    total = queried.total;
  } else if (all.length > MAX_EXPORT_ROWS) {
    view = all.slice(0, MAX_EXPORT_ROWS);
  }
  const columns = normalized.source === "search" ? SEARCH_EXPORT_COLUMNS : DEFAULT_EXPORT_COLUMNS;
  const body = {
    source: normalized.source,
    format: normalized.format,
    count: view.length,
    total,
    truncated: total > view.length,
    filter: {
      q: normalized.q,
      demand: normalized.demand,
      chip: normalized.chip,
      sort: normalized.sort,
      dir: normalized.dir,
    },
  };
  if (normalized.format === "json") {
    body.rows = view;
  } else {
    body.filename = makeExportFilename(normalized.source === "search" ? "etsy-search-results" : "etsy-scrape", now);
    body.csv = rowsToCsv(view, columns);
  }
  return { kind: "export", body };
}

export function shapeStats(stats = {}) {
  return {
    kind: "stats",
    body: {
      count: Number(stats.total) || 0,
      total: Number(stats.total) || 0,
      digital: Number(stats.digital) || 0,
      withDemand: Number(stats.withDemand) || 0,
      searchResults: Number(stats.searchResults) || 0,
    },
  };
}

function snapshot(cfg, extra) {
  return { laneName: cfg?.laneName, backendHost: cfg?.origin, ...extra };
}

async function uploadWithRetry(deps, body) {
  return deliverListings(deps, body);
}

async function uploadPayloadWithRetry(deps, body) {
  return uploadWithBackoff((part) => deps.uploadPayload?.(part), body, { sleep: deps.sleep });
}

function classifyUpload(uploaded, listingsUploaded) {
  if (uploaded?.ok) return { ok: true, listingsUploaded: uploaded.listings_uploaded ?? listingsUploaded };
  if (uploaded?.error === "already_completed") return { done: true, listingsUploaded };
  if (uploaded?.error === "lease_lost") return { leaseLost: true, listingsUploaded };
  return {
    error: uploaded?.error || "upload_failed",
    listingsUploaded,
    retryable: isRetryableUploadFailure(uploaded),
  };
}

async function finishBlocked(deps, cfg, job, block, page, listingsUploaded) {
  const reason = block?.reason || "captcha";
  await deps.fail?.({ jobId: job.id, blocked: true, error: `${reason}:page:${page}` });
  await deps.writeSession?.(snapshot(cfg, {
    status: "blocked",
    phase: "captcha",
    jobId: job.id,
    term: job.term,
    page,
    lastError: reason,
    listingsUploaded,
  }));
  return { status: "blocked", reason, page, listingsUploaded };
}

async function finishUploadProblem(deps, cfg, job, outcome, page) {
  if (outcome.done) return { status: "completed", already: true, page, listingsUploaded: outcome.listingsUploaded };
  if (outcome.leaseLost) {
    await deps.writeSession?.(snapshot(cfg, {
      status: "error",
      phase: "lease_lost",
      jobId: job.id,
      term: job.term,
      page,
      lastError: "lease_lost",
      listingsUploaded: outcome.listingsUploaded,
    }));
    return { status: "lease_lost", page, listingsUploaded: outcome.listingsUploaded };
  }
  await deps.fail?.({ jobId: job.id, blocked: false, error: outcome.error, retryable: outcome.retryable === true });
  await deps.writeSession?.(snapshot(cfg, {
    status: "error",
    phase: "upload",
    jobId: job.id,
    term: job.term,
    page,
    lastError: outcome.error,
    listingsUploaded: outcome.listingsUploaded,
  }));
  return { status: "failed", error: outcome.error, page, listingsUploaded: outcome.listingsUploaded };
}

export async function runScrapeListings({ job, cfg, deps }) {
  const urls = normalizeListingUrls(jobParams(job).urls);
  if (!job?.id || urls.length === 0) {
    await deps.fail?.({ jobId: job?.id, blocked: false, error: "invalid_job" });
    return { status: "failed", error: "invalid_job" };
  }
  let listingsUploaded = 0;
  await deps.ensureTab?.();
  await deps.writeSession?.(snapshot(cfg, {
    status: "running",
    phase: "listing",
    jobId: job.id,
    term: job.term,
    page: 0,
    pages: urls.length,
    listingsUploaded: 0,
    lastError: "",
  }));

  for (let index = 0; index < urls.length; index += 1) {
    if (deps.isCancelled?.()) return { status: "cancelled", listingsUploaded };
    if (index > 0) await deps.sleep?.(paceDelayMs(cfg, deps.rand));
    const page = index + 1;
    await deps.navigate?.(urls[index]);
    const block = await deps.detectBlock?.();
    if (block?.blocked) return finishBlocked(deps, cfg, job, block, page, listingsUploaded);
    await deps.heartbeat?.({ jobId: job.id, page, pages: urls.length, listingsUploaded, phase: "listing" });
    const extracted = await deps.extractListing?.({ url: urls[index], searchTerm: job.term || "" });
    const listing = extracted?.listing;
    if (!listing || listing.found === false) continue;
    const uploaded = classifyUpload(await uploadWithRetry(deps, {
      jobId: job.id,
      page,
      listings: [listingDetailRow(listing, 1, page)],
      totalResults: null,
    }), listingsUploaded);
    if (!uploaded.ok) return finishUploadProblem(deps, cfg, job, uploaded, page);
    listingsUploaded = uploaded.listingsUploaded;
    const detail = classifyUpload(await uploadPayloadWithRetry(deps, {
      jobId: job.id,
      kind: "listing",
      body: { count: 1, listing: listingDetailPayload(listing) },
    }), listingsUploaded);
    if (!detail.ok) return finishUploadProblem(deps, cfg, job, detail, page);
  }

  const done = await deps.complete?.({
    jobId: job.id,
    pagesDone: urls.length,
    listingsUploaded,
    phase: "done",
  });
  if (done && done.ok === false) return { status: "failed", error: done.error || "complete_failed", listingsUploaded };
  await deps.writeSession?.(snapshot(cfg, {
    status: "idle",
    phase: "done",
    jobId: job.id,
    term: job.term,
    page: urls.length,
    pages: urls.length,
    listingsUploaded,
    lastError: "",
  }));
  return { status: "completed", listingsUploaded };
}

export async function runScrapeShop({ job, cfg, deps }) {
  const params = jobParams(job);
  const shop = String(params.shop || "").trim();
  const pages = Math.max(1, Math.min(MAX_SHOP_PAGES, Number(params.pages || job?.pages) || 1));
  const visit = params.visitListings === true;
  if (!job?.id || !buildShopUrl(shop, 1)) {
    await deps.fail?.({ jobId: job?.id, blocked: false, error: "invalid_job" });
    return { status: "failed", error: "invalid_job" };
  }
  let listingsUploaded = 0;
  let visitsLeft = visit ? MAX_SHOP_VISITS : 0;
  await deps.ensureTab?.();
  await deps.writeSession?.(snapshot(cfg, {
    status: "running",
    phase: "shop",
    jobId: job.id,
    term: shop,
    page: 0,
    pages,
    listingsUploaded: 0,
    lastError: "",
  }));

  for (let page = 1; page <= pages; page += 1) {
    if (deps.isCancelled?.()) return { status: "cancelled", listingsUploaded };
    if (page > 1) await deps.sleep?.(paceDelayMs(cfg, deps.rand));
    let path = "url_navigation";
    if (page > 1) {
      const next = await deps.clickNext?.(page - 1);
      if (next?.ok && next.path === "pagination_click") {
        path = "pagination_click";
        const landed = await deps.waitForNavigation?.();
        if (!landed) {
          path = "url_navigation";
          await deps.navigate?.(buildShopUrl(shop, page));
        }
      } else {
        await deps.navigate?.(buildShopUrl(shop, page));
      }
    } else {
      await deps.navigate?.(buildShopUrl(shop, page));
    }
    const block = await deps.detectBlock?.();
    if (block?.blocked) return finishBlocked(deps, cfg, job, block, page, listingsUploaded);
    await deps.heartbeat?.({ jobId: job.id, page, pages, listingsUploaded, phase: "shop", search_path: path });
    const extracted = await deps.extractShop?.();
    if (extracted?.block?.blocked) return finishBlocked(deps, cfg, job, extracted.block, page, listingsUploaded);
    const listings = listingRowsForUpload({
      ...(extracted?.payload || { results: [] }),
      results: (extracted?.payload?.results || []).map((row) => ({ ...row, page })),
    });
    const uploaded = classifyUpload(await uploadWithRetry(deps, {
      jobId: job.id,
      page,
      listings,
      totalResults: extracted?.payload?.totalResults ?? null,
    }), listingsUploaded);
    if (!uploaded.ok) return finishUploadProblem(deps, cfg, job, uploaded, page);
    listingsUploaded = uploaded.listingsUploaded;

    for (const row of listings) {
      if (visitsLeft <= 0) break;
      if (deps.isCancelled?.()) return { status: "cancelled", listingsUploaded };
      visitsLeft -= 1;
      await deps.sleep?.(paceDelayMs(cfg, deps.rand));
      await deps.navigate?.(row.listing_url);
      const visitBlock = await deps.detectBlock?.();
      if (visitBlock?.blocked) return finishBlocked(deps, cfg, job, visitBlock, page, listingsUploaded);
      const extractedListing = await deps.extractListing?.({ url: row.listing_url, searchTerm: shop });
      const listing = extractedListing?.listing;
      if (!listing || listing.found === false) continue;
      const detail = classifyUpload(await uploadPayloadWithRetry(deps, {
        jobId: job.id,
        kind: "listing",
        body: { count: 1, listing: listingDetailPayload(listing) },
      }), listingsUploaded);
      if (!detail.ok) return finishUploadProblem(deps, cfg, job, detail, page);
    }
  }

  const done = await deps.complete?.({
    jobId: job.id,
    pagesDone: pages,
    listingsUploaded,
    phase: "done",
    shop,
  });
  if (done && done.ok === false) return { status: "failed", error: done.error || "complete_failed", listingsUploaded };
  await deps.writeSession?.(snapshot(cfg, {
    status: "idle",
    phase: "done",
    jobId: job.id,
    term: shop,
    page: pages,
    pages,
    listingsUploaded,
    lastError: "",
  }));
  return { status: "completed", listingsUploaded, shop };
}

async function runLocalRead({ job, cfg, deps, phase, produce }) {
  if (!job?.id) return { status: "failed", error: "invalid_job" };
  await deps.writeSession?.(snapshot(cfg, {
    status: "running",
    phase,
    jobId: job.id,
    term: job.term,
    lastError: "",
  }));
  const built = await produce();
  if (!built?.body) {
    const error = built?.error || `${phase}_failed`;
    await deps.fail?.({ jobId: job.id, blocked: false, error });
    return { status: "failed", error };
  }
  const uploaded = classifyUpload(await uploadPayloadWithRetry(deps, {
    jobId: job.id,
    kind: built.kind,
    body: built.body,
  }), 0);
  if (!uploaded.ok) return finishUploadProblem(deps, cfg, job, uploaded, 1);
  const done = await deps.complete?.({
    jobId: job.id,
    phase: "done",
    rows: built.body.count ?? built.body.total ?? 0,
  });
  if (done && done.ok === false) return { status: "failed", error: done.error || "complete_failed" };
  await deps.writeSession?.(snapshot(cfg, {
    status: "idle",
    phase: "done",
    jobId: job.id,
    term: job.term,
    listingsUploaded: built.body.count ?? built.body.total ?? 0,
    lastError: "",
  }));
  return { status: "completed", rows: built.body.count ?? built.body.total ?? 0 };
}

export function runExportCommand({ job, cfg, deps }) {
  return runLocalRead({
    job,
    cfg,
    deps,
    phase: "export",
    produce: () => deps.buildExport?.(jobParams(job)),
  });
}

export function runStatsCommand({ job, cfg, deps }) {
  return runLocalRead({
    job,
    cfg,
    deps,
    phase: "stats",
    produce: () => deps.readStats?.(),
  });
}

async function dispatchWorkerJob({ job, cfg, deps }) {
  const type = jobTypeOf(job);
  if (type === "search") return runClaimedSearch({ job, cfg, deps });
  if (type === "scrape-listings") return runScrapeListings({ job, cfg, deps });
  if (type === "scrape-shop") return runScrapeShop({ job, cfg, deps });
  if (type === "export") return runExportCommand({ job, cfg, deps });
  if (type === "collection-stats") return runStatsCommand({ job, cfg, deps });
  await deps.fail?.({ jobId: job?.id, blocked: false, error: `unknown_job_type:${type}` });
  return { status: "failed", error: "unknown_job_type" };
}

export async function runWorkerJob({ job, cfg, deps }) {
  try {
    const result = await dispatchWorkerJob({ job, cfg, deps });
    if (result?.status === "cancelled") {
      await deps.release?.({ jobId: job?.id });
      await deps.writeSession?.(snapshot(cfg, {
        status: "idle",
        phase: "released",
        jobId: job?.id,
        term: job?.term,
        lastError: "",
      }));
      return { ...result, status: "released" };
    }
    return result;
  } catch (error) {
    const message = String(error?.message || error || "navigation_failed").slice(0, 300);
    if (deps.isCancelled?.()) {
      await deps.release?.({ jobId: job?.id, error: message });
      await deps.writeSession?.(snapshot(cfg, {
        status: "idle",
        phase: "released",
        jobId: job?.id,
        term: job?.term,
        lastError: "",
      }));
      return { status: "released", error: message };
    }
    await deps.fail?.({ jobId: job?.id, blocked: false, error: message, retryable: true });
    await deps.writeSession?.(snapshot(cfg, {
      status: "error",
      phase: "navigation",
      jobId: job?.id,
      term: job?.term,
      lastError: message,
    }));
    return { status: "failed", error: message, retryable: true };
  }
}
