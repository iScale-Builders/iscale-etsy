// @vitest-environment node
import { rm } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { buildEnqueue, parseWorkerArgs, runWorkerCli, tokenCachePath } from "../src/core/worker-cli.js";
import { rpcUrl } from "../src/core/worker-client.js";
import { isPendingJobWake, realtimeJoinMessage, realtimeWebSocketUrl } from "../src/core/worker-realtime.js";
import { idlePickupWithinSla, normalizeWorkerSettings, sanitizeLaneSnapshot } from "../src/core/worker-config.js";

describe("parseWorkerArgs", () => {
  it("reads add-terms priority and search-now", () => {
    expect(parseWorkerArgs(["add-terms", "linen apron", "--priority", "10", "--pages", "2"])).toMatchObject({
      command: "add-terms",
      flags: { priority: "10", pages: "2" },
      positionals: ["linen apron"],
    });
    expect(parseWorkerArgs(["search-now", "rush term"])).toMatchObject({
      command: "search-now",
      positionals: ["rush term"],
    });
    expect(parseWorkerArgs(["status", "--term", "linen apron"])).toMatchObject({
      command: "status",
      flags: { term: "linen apron" },
    });
    expect(parseWorkerArgs(["results", "--term", "linen apron", "--json"]).flags.json).toBe(true);
    expect(parseWorkerArgs(["scrape-listings", "--url", "https://www.etsy.com/listing/1234567890", "--url", "https://www.etsy.com/listing/1234567891"])).toMatchObject({
      command: "scrape-listings",
      flags: { urls: ["https://www.etsy.com/listing/1234567890", "https://www.etsy.com/listing/1234567891"] },
    });
    expect(parseWorkerArgs(["scrape-shop", "--shop", "CoolShop", "--pages", "2", "--visit"]).flags.visit).toBe(true);
  });
});

function fakeFetch(routes) {
  const impl = async (url, init) => {
    impl.calls.push({ url: String(url), init });
    const href = String(url);
    if (href.includes("/auth/v1/token")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: "user-access-token",
          refresh_token: "user-refresh-token",
          expires_in: 3600,
        }),
      };
    }
    const body = JSON.parse(init.body);
    const fn = String(url).split("/").pop();
    const handler = routes[fn];
    if (!handler) return { ok: false, status: 404, text: async () => JSON.stringify({ message: "missing" }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(handler(body)) };
  };
  impl.calls = [];
  return impl;
}

describe("runWorkerCli", () => {
  const cache = "/tmp/iscale-etsy-worker-token.json";
  const env = {
    ETSY_WORKER_URL: "https://example.test",
    ETSY_WORKER_ANON_KEY: "publishable-key",
    ETSY_WORKER_EMAIL: "lane@example.test",
    ETSY_WORKER_PASSWORD: "lane-password",
    ETSY_WORKER_TOKEN_CACHE: cache,
  };

  beforeEach(async () => {
    await rm(cache, { force: true });
  });

  it("posts add-terms with priority and prints search-now", async () => {
    const seen = [];
    const fetchImpl = fakeFetch({
      etsy_worker_add_terms: (body) => {
        seen.push(body);
        return { ok: true, jobs: [{ id: "1", term: "linen apron", action: "inserted", priority: body.p_priority }] };
      },
      etsy_worker_search_now: (body) => ({ ok: true, id: "2", term: body.p_term, action: "inserted", priority: 40 }),
    });
    const lines = [];
    const code = await runWorkerCli(["add-terms", "linen apron", "--priority", "10"], env, fetchImpl, {
      log: (line) => lines.push(line),
      error: (line) => lines.push(`ERR ${line}`),
    });
    expect(code).toBe(0);
    expect(seen[0]).toMatchObject({ p_terms: ["linen apron"], p_priority: 10, p_pages: 1 });
    expect(lines[0]).toContain("inserted: linen apron priority=10");
    const auth = fetchImpl.calls.find((call) => call.url.includes("/auth/v1/token"));
    const rpc = fetchImpl.calls.find((call) => call.url.includes("etsy_worker_add_terms"));
    expect(auth.init.headers.apikey).toBe("publishable-key");
    expect(auth.init.headers.authorization).toBeUndefined();
    expect(JSON.parse(auth.init.body)).toMatchObject({ email: "lane@example.test", password: "lane-password" });
    expect(rpc.init.headers.apikey).toBe("publishable-key");
    expect(rpc.init.headers.authorization).toBe("Bearer user-access-token");
    expect(rpc.init.headers.authorization).not.toContain("publishable-key");

    const now = [];
    const nowCode = await runWorkerCli(["search-now", "rush term"], env, fetchImpl, {
      log: (line) => now.push(line),
      error: () => {},
    });
    expect(nowCode).toBe(0);
    expect(now[0]).toContain("priority=40");
  });

  it("prints term status fields and results json", async () => {
    const fetchImpl = fakeFetch({
      etsy_worker_term_status: () => ({
        ok: true,
        term: "linen apron",
        state: "processing",
        lane: "lane-1",
        pages_done: 1,
        pages: 2,
        rows: 48,
        total_results: 12480,
        last_error: null,
        priority: 10,
        attempt: 1,
        search_path: "search_box",
      }),
      etsy_worker_results: () => ({
        ok: true,
        job: { term: "linen apron", state: "processing", rows: 1, total_results: 12480 },
        listings: [{ listing_id: "1111111111", title: "Apron", page: 1, position: 1 }],
      }),
    });
    const status = [];
    expect(await runWorkerCli(["status", "--term", "linen apron"], env, fetchImpl, {
      log: (line) => status.push(line),
      error: () => {},
    })).toBe(0);
    expect(status.join("\n")).toContain("state: processing");
    expect(status.join("\n")).toContain("lane: lane-1");
    expect(status.join("\n")).toContain("pages_done: 1");
    expect(status.join("\n")).toContain("rows: 48");
    expect(status.join("\n")).toContain("total_results: 12480");
    expect(status.join("\n")).toContain("search_path: search_box");

    const results = [];
    expect(await runWorkerCli(["results", "--term", "linen apron", "--json"], env, fetchImpl, {
      log: (line) => results.push(line),
      error: () => {},
    })).toBe(0);
    const parsed = JSON.parse(results.join("\n"));
    expect(parsed.listings[0].listing_id).toBe("1111111111");
  });

  it("enqueues a listing batch and reads it back by job id", async () => {
    const seen = [];
    const fetchImpl = fakeFetch({
      etsy_worker_enqueue: (body) => {
        seen.push(body);
        return { ok: true, id: "job-9", type: body.p_type, action: "inserted", subject: "listings (1)", priority: body.p_priority };
      },
      etsy_worker_job_results: (body) => ({
        ok: true,
        job: { id: body.p_job_id, type: "scrape-listings", term: "listings (1)", state: "completed", rows: 1 },
        listings: [],
        payloads: [{ kind: "listing", body: { listing: { listingId: "1234567890", title: "Mug" } } }],
      }),
    });
    const lines = [];
    const code = await runWorkerCli(
      ["scrape-listings", "--url", "https://www.etsy.com/listing/1234567890/nice-mug", "--priority", "3"],
      env,
      fetchImpl,
      { log: (line) => lines.push(line), error: (line) => lines.push(`ERR ${line}`) },
    );
    expect(code).toBe(0);
    expect(seen[0].p_type).toBe("scrape-listings");
    expect(seen[0].p_params.urls).toEqual(["https://www.etsy.com/listing/1234567890"]);
    expect(lines[0]).toContain("id=job-9");

    const read = [];
    const readCode = await runWorkerCli(["results", "--job", "job-9", "--json"], env, fetchImpl, {
      log: (line) => read.push(line),
      error: () => {},
    });
    expect(readCode).toBe(0);
    expect(JSON.parse(read.join("\n")).payloads[0].body.listing.title).toBe("Mug");
  });

  it("rejects a non-etsy listing url before calling the backend", async () => {
    const code = await runWorkerCli(["scrape-listings", "--url", "https://example.com/listing/1234567890"], env, async () => {
      throw new Error("should not fetch");
    }, { log: () => {}, error: () => {} });
    expect(code).toBe(2);
    expect(buildEnqueue(parseWorkerArgs(["export", "--source", "shop", "--format", "json", "--chip", "in_carts"])).params).toMatchObject({
      source: "shop",
      format: "json",
      chip: "in_carts",
    });
  });

  it("refuses to run without the backend env and does not echo a key", async () => {
    const errors = [];
    const code = await runWorkerCli(["status"], {}, async () => {
      throw new Error("should not fetch");
    }, { log: () => {}, error: (line) => errors.push(line) });
    expect(code).toBe(1);
    expect(errors[0]).toContain("ETSY_WORKER_URL");
    expect(errors.join("\n")).not.toContain("publishable-key");
  });

  it("rejects a secret key before calling the backend", async () => {
    let fetched = false;
    const errors = [];
    const code = await runWorkerCli(["health"], {
      ...env,
      ETSY_WORKER_ANON_KEY: `sb_secret_${"a".repeat(24)}`,
    }, async () => {
      fetched = true;
      throw new Error("should not fetch");
    }, { log: () => {}, error: (line) => errors.push(line) });
    expect(code).toBe(1);
    expect(fetched).toBe(false);
    expect(errors.join("\n")).toMatch(/service_role|sb_secret_/);
  });

  it("keeps the token cache outside the repository", () => {
    expect(tokenCachePath({ ETSY_WORKER_TOKEN_CACHE: cache }, process.cwd())).toBe(cache);
    expect(() => tokenCachePath({ ETSY_WORKER_TOKEN_CACHE: "worker-token.json" }, process.cwd())).toThrow(/outside the repository/);
  });
});

describe("worker client and realtime helpers", () => {
  it("builds a rest rpc url without a baked-in project", () => {
    expect(rpcUrl("https://example.test/rest/v1", "etsy_worker_health")).toBe("https://example.test/rest/v1/rpc/etsy_worker_health");
    expect(() => rpcUrl("http://evil.example", "etsy_worker_health")).toThrow(/https_required/);
  });

  it("builds a realtime socket and recognizes a pending insert", () => {
    const url = new URL(realtimeWebSocketUrl("https://example.test", "publishable-key"));
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/realtime/v1/websocket");
    expect(url.searchParams.get("apikey")).toBe("publishable-key");
    expect(realtimeJoinMessage().payload.config.postgres_changes[0]).toMatchObject({
      event: "INSERT",
      schema: "etsy_worker",
      table: "jobs",
    });
    expect(isPendingJobWake({
      event: "postgres_changes",
      payload: { data: { type: "INSERT", record: { status: "pending" } } },
    })).toBe(true);
    expect(isPendingJobWake({ payload: { data: { type: "UPDATE", record: { status: "processing" } } } })).toBe(false);
  });

  it("stays off and unready until a person configures it", () => {
    const off = normalizeWorkerSettings({});
    expect(off.enabled).toBe(false);
    expect(off.ready).toBe(false);
    const on = normalizeWorkerSettings({
      workerEnabled: true,
      workerBackendUrl: "https://example.test",
      workerAnonKey: "k",
      workerLaneName: "lane 1",
      workerPollSeconds: 20,
    });
    expect(on.ready).toBe(true);
    expect(on.laneName).toBe("lane 1");
    expect(idlePickupWithinSla(on.pollSeconds)).toBe(true);
    expect(sanitizeLaneSnapshot({ laneName: "lane 1", anonKey: "k", workerAnonKey: "secret", status: "idle" })).toEqual({
      laneName: "lane 1",
      status: "idle",
    });
  });
});
