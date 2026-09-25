import { describe, expect, it } from "vitest";
import { JOB_TYPES, runScrapeListings, runScrapeShop, runWorkerJob, shapeExport, shapeStats } from "../src/core/worker-commands.js";

function cfg() {
  return { enabled: true, ready: true, laneName: "lane-1", origin: "https://example.test", paceMinMs: 0, paceMaxMs: 0 };
}

function harness(overrides = {}) {
  const calls = [];
  const note = (name) => async (...args) => {
    calls.push(name);
    return overrides[name]?.(...args);
  };
  return {
    calls,
    deps: {
      isCancelled: () => false,
      sleep: async () => {},
      rand: () => 0,
      writeSession: async () => {},
      ensureTab: note("ensureTab"),
      navigate: note("navigate"),
      detectBlock: note("detectBlock"),
      extractListing: note("extractListing"),
      extractShop: note("extractShop"),
      clickNext: note("clickNext"),
      waitForNavigation: note("waitForNavigation"),
      upload: note("upload"),
      uploadPayload: note("uploadPayload"),
      heartbeat: note("heartbeat"),
      complete: note("complete"),
      fail: note("fail"),
      release: note("release"),
      buildExport: note("buildExport"),
      readStats: note("readStats"),
    },
  };
}

const listing = {
  found: true,
  id: "listing_1234567890",
  listingId: "1234567890",
  title: "Blue Mug",
  url: "https://www.etsy.com/listing/1234567890",
  price: "$12.00",
  priceNumeric: 12,
  currency: "USD",
  shopName: "CoolShop",
  favorites: 4,
  reviewCount: 8,
  firstReview: "2020-01-01",
  lastReview: "2024-01-01",
  demandText: "20 in carts",
  isDigital: false,
};

describe("worker command executors", () => {
  it("visits each listing url, uploads the row and detail, and stops on captcha", async () => {
    const job = {
      id: "job-1",
      type: "scrape-listings",
      term: "listings (2)",
      params: {
        urls: ["https://www.etsy.com/listing/1234567890/blue-mug", "https://www.etsy.com/listing/2222222222"],
      },
    };
    const api = harness({
      detectBlock: async () => ({ blocked: false }),
      extractListing: async () => ({ listing }),
      upload: async () => ({ ok: true, listings_uploaded: 1 }),
      uploadPayload: async () => ({ ok: true, listings_uploaded: 1 }),
      complete: async () => ({ ok: true }),
    });
    const result = await runScrapeListings({ job, cfg: cfg(), deps: api.deps });
    expect(result.status).toBe("completed");
    expect(api.calls.filter((name) => name === "navigate")).toHaveLength(2);
    expect(api.calls).toContain("complete");
    expect(api.calls).not.toContain("fail");

    let checks = 0;
    const blocked = harness({
      detectBlock: async () => {
        checks += 1;
        return checks === 1 ? { blocked: false } : { blocked: true, reason: "captcha" };
      },
      extractListing: async () => ({ listing }),
      upload: async () => ({ ok: true, listings_uploaded: 1 }),
      uploadPayload: async () => ({ ok: true }),
      fail: async () => ({ ok: true }),
    });
    const stopped = await runWorkerJob({ job, cfg: cfg(), deps: blocked.deps });
    expect(stopped).toMatchObject({ status: "blocked", reason: "captcha" });
    expect(blocked.calls.filter((name) => name === "upload")).toHaveLength(1);
    expect(blocked.calls).toContain("fail");
    expect(blocked.calls).not.toContain("complete");
  });

  it("captures shop cards without visiting listings unless asked", async () => {
    const job = {
      id: "job-2",
      job_type: "scrape-shop",
      term: "CoolShop",
      pages: 1,
      params: { shop: "CoolShop", pages: 1, visitListings: false },
    };
    const api = harness({
      detectBlock: async () => ({ blocked: false }),
      extractShop: async () => ({
        block: { blocked: false },
        payload: {
          totalResults: 1,
          results: [{ listingId: "1234567890", title: "Blue Mug", url: "https://www.etsy.com/listing/1234567890", position: 1, page: 1 }],
        },
      }),
      upload: async () => ({ ok: true, listings_uploaded: 1 }),
      complete: async () => ({ ok: true }),
    });
    const result = await runScrapeShop({ job, cfg: cfg(), deps: api.deps });
    expect(result.status).toBe("completed");
    expect(api.calls.filter((name) => name === "navigate")).toEqual(["navigate"]);
    expect(api.calls).not.toContain("extractListing");

    const visiting = harness({
      detectBlock: async () => ({ blocked: false }),
      extractShop: async () => ({
        block: { blocked: false },
        payload: {
          results: [{ listingId: "1234567890", title: "Blue Mug", url: "https://www.etsy.com/listing/1234567890", position: 1, page: 1 }],
        },
      }),
      extractListing: async () => ({ listing }),
      upload: async () => ({ ok: true, listings_uploaded: 1 }),
      uploadPayload: async () => ({ ok: true }),
      complete: async () => ({ ok: true }),
    });
    const deep = await runWorkerJob({
      job: { ...job, params: { ...job.params, visitListings: true } },
      cfg: cfg(),
      deps: visiting.deps,
    });
    expect(deep.status).toBe("completed");
    expect(visiting.calls).toContain("extractListing");
  });

  it("exports and stats stay off Etsy and omit worker settings", async () => {
    const rows = [
      { listingId: "1234567890", title: "Blue Mug", url: "https://www.etsy.com/listing/1234567890", shopName: "CoolShop", price: "$12", demandText: "in 20 carts", workerAnonKey: "secret-key" },
      { listingId: "2222222222", title: "Other", url: "https://www.etsy.com/listing/2222222222", shopName: "Elsewhere", price: "$4", demandText: "" },
    ];
    const shaped = shapeExport(rows, { source: "shop", format: "csv", chip: "in_carts", q: "mug" });
    expect(shaped.body.count).toBe(1);
    expect(shaped.body.csv).toContain("Blue Mug");
    expect(shaped.body.csv).not.toContain("secret-key");
    expect(shaped.body.csv).not.toContain("Elsewhere");
    const stats = shapeStats({ total: 2, digital: 1, withDemand: 1, searchResults: 4, settings: { workerAnonKey: "secret-key" } });
    expect(stats.body).toEqual({ count: 2, total: 2, digital: 1, withDemand: 1, searchResults: 4 });
    expect(JSON.stringify(stats)).not.toContain("secret-key");

    const api = harness({
      buildExport: async () => shaped,
      uploadPayload: async () => ({ ok: true }),
      complete: async () => ({ ok: true }),
    });
    const exported = await runWorkerJob({
      job: { id: "job-3", type: "export", term: "export shop", params: { source: "shop", format: "csv" } },
      cfg: cfg(),
      deps: api.deps,
    });
    expect(exported.status).toBe("completed");
    expect(api.calls).not.toContain("navigate");
    expect(JOB_TYPES).toContain("collection-stats");
  });

  it("reports a navigation throw as a retryable failure", async () => {
    const fails = [];
    const api = harness({
      navigate: async () => {
        throw new Error("tab closed");
      },
      fail: async (info) => {
        fails.push(info);
        return { ok: true };
      },
    });
    const result = await runWorkerJob({
      job: {
        id: "job-nav",
        type: "scrape-listings",
        params: { urls: ["https://www.etsy.com/listing/1234567890/blue-mug"] },
      },
      cfg: cfg(),
      deps: api.deps,
    });
    expect(result).toMatchObject({ status: "failed", error: "tab closed", retryable: true });
    expect(fails[0]).toMatchObject({ blocked: false, error: "tab closed", retryable: true });
    expect(api.calls).not.toContain("release");
  });

  it("releases a job without failing it when worker mode turns off mid-navigation", async () => {
    let cancelled = false;
    const released = [];
    const api = harness({
      navigate: async () => {
        cancelled = true;
        throw new Error("stopped");
      },
      release: async (info) => {
        released.push(info);
        return { ok: true };
      },
    });
    api.deps.isCancelled = () => cancelled;
    const result = await runWorkerJob({
      job: {
        id: "job-stop",
        type: "scrape-listings",
        params: { urls: ["https://www.etsy.com/listing/1234567890/blue-mug"] },
      },
      cfg: cfg(),
      deps: api.deps,
    });
    expect(result.status).toBe("released");
    expect(released[0]).toMatchObject({ jobId: "job-stop" });
    expect(api.calls).not.toContain("fail");
  });

  it("fails an unknown job type instead of leaving it claimed", async () => {
    const api = harness({ fail: async () => ({ ok: true }) });
    const result = await runWorkerJob({ job: { id: "job-4", type: "delete-everything" }, cfg: cfg(), deps: api.deps });
    expect(result).toMatchObject({ status: "failed", error: "unknown_job_type" });
    expect(api.calls).toContain("fail");
  });
});
