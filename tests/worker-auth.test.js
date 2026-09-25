// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  accessTokenFresh,
  classifyApiKey,
  ensureWorkerSession,
  refreshAccessToken,
  signInWithPassword,
  workerAuthHeaders,
} from "../src/core/worker-auth.js";
import { createWorkerClient } from "../src/core/worker-client.js";
import { normalizeWorkerSettings, redactWorkerCredentials } from "../src/core/worker-config.js";
import { realtimeAccessTokenMessage, realtimeJoinMessage } from "../src/core/worker-realtime.js";

function jwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

const publishable = `sb_publishable_${"k".repeat(12)}`;
const secret = `sb_secret_${"s".repeat(12)}`;

describe("classifyApiKey", () => {
  it("accepts a publishable key and a legacy anon jwt, and rejects secrets", () => {
    expect(classifyApiKey("")).toMatchObject({ ok: false, error: "missing_anon_key" });
    expect(classifyApiKey("k")).toMatchObject({ ok: true, kind: "apikey", key: "k" });
    expect(classifyApiKey(publishable)).toMatchObject({ ok: true, kind: "publishable" });
    expect(classifyApiKey(secret)).toMatchObject({ ok: false, error: "secret_key_rejected" });
    const anon = jwt({ role: "anon" });
    expect(classifyApiKey(anon)).toMatchObject({ ok: true, kind: "anon_jwt", key: anon });
    expect(classifyApiKey(jwt({ role: "service_role" }))).toMatchObject({ ok: false, error: "service_role_rejected" });
  });
});

describe("workerAuthHeaders", () => {
  it("puts the api key in apikey and the user token in Authorization", () => {
    const anon = jwt({ role: "anon" });
    const headers = workerAuthHeaders(anon, "user-access-token");
    expect(headers).toEqual({ apikey: anon, authorization: "Bearer user-access-token" });
    expect(headers.authorization).not.toContain(anon);
    expect(workerAuthHeaders(publishable, "user-access-token").apikey).toBe(publishable);
  });

  it("never sends a publishable, secret, anon, or service-role key as the bearer", () => {
    const anon = jwt({ role: "anon" });
    expect(() => workerAuthHeaders(publishable, publishable)).toThrow(/api_key_is_not_a_bearer_token/);
    expect(() => workerAuthHeaders(publishable, secret)).toThrow(/api_key_is_not_a_bearer_token/);
    expect(() => workerAuthHeaders(anon, anon)).toThrow(/api_key_is_not_a_bearer_token/);
    expect(() => workerAuthHeaders("k", jwt({ role: "service_role" }))).toThrow(/service_role_rejected/);
    expect(() => workerAuthHeaders("k", "")).toThrow(/missing_access_token/);
    expect(() => workerAuthHeaders(secret, "user-access-token")).toThrow(/secret_key_rejected/);
  });
});

describe("password grant", () => {
  it("signs in and refreshes with the apikey header only", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: "user-access-token",
          refresh_token: "user-refresh-token",
          expires_in: 3600,
        }),
      };
    };
    const now = 1_700_000_000_000;
    const signed = await signInWithPassword({
      fetchImpl,
      backendUrl: "https://example.test",
      apiKey: publishable,
      email: "lane@example.test",
      password: "lane-password",
      now,
    });
    expect(signed.ok).toBe(true);
    expect(signed.expiresAt).toBe(now + 3600 * 1000);
    expect(seen[0].url).toContain("/auth/v1/token?grant_type=password");
    expect(seen[0].headers.apikey).toBe(publishable);
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].body).toEqual({ email: "lane@example.test", password: "lane-password" });

    const refreshed = await refreshAccessToken({
      fetchImpl,
      backendUrl: "https://example.test/rest/v1",
      apiKey: publishable,
      refreshToken: signed.refreshToken,
      now,
    });
    expect(refreshed.ok).toBe(true);
    expect(seen[1].url).toBe("https://example.test/auth/v1/token?grant_type=refresh_token");
    expect(seen[1].body).toEqual({ refresh_token: "user-refresh-token" });
  });

  it("refreshes before expiry and keeps a fresh access token", async () => {
    const now = 1_700_000_000_000;
    expect(accessTokenFresh({ accessToken: "user-access-token", expiresAt: now + 120_000 }, now)).toBe(true);
    expect(accessTokenFresh({ accessToken: "user-access-token", expiresAt: now + 30_000 }, now)).toBe(false);
    let grants = 0;
    const fetchImpl = async (url) => {
      grants += 1;
      expect(String(url)).toContain("grant_type=refresh_token");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: "refreshed-token",
          refresh_token: "next-refresh",
          expires_in: 3600,
        }),
      };
    };
    const session = await ensureWorkerSession({
      fetchImpl,
      backendUrl: "https://example.test",
      apiKey: "k",
      email: "lane@example.test",
      password: "lane-password",
      stored: { accessToken: "user-access-token", refreshToken: "user-refresh-token", expiresAt: now + 30_000 },
      now,
    });
    expect(grants).toBe(1);
    expect(session).toMatchObject({ ok: true, accessToken: "refreshed-token", refreshed: true });
  });
});

describe("createWorkerClient", () => {
  it("sends apikey plus the user bearer for both key shapes", async () => {
    const anon = jwt({ role: "anon" });
    for (const apiKey of [publishable, anon, "k"]) {
      const seen = [];
      const client = createWorkerClient({
        backendUrl: "https://example.test",
        anonKey: apiKey,
        accessToken: "user-access-token",
        fetchImpl: async (url, init) => {
          seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, job: null }) };
        },
      });
      const result = await client.claimJob("lane-1", 180);
      expect(result.ok).toBe(true);
      expect(seen[0].headers.apikey).toBe(apiKey);
      expect(seen[0].headers.authorization).toBe("Bearer user-access-token");
      if (apiKey.length > 1) expect(seen[0].headers.authorization).not.toContain(apiKey);
    }
  });

  it("marks a thrown fetch as a retryable network failure", async () => {
    const client = createWorkerClient({
      backendUrl: "https://example.test",
      anonKey: "k",
      accessToken: "user-access-token",
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    });
    const result = await client.uploadResults({ jobId: "job-1", laneName: "lane-1", listings: [], page: 1 });
    expect(result).toMatchObject({ ok: false, network: true });
    expect(result.error).not.toContain("k");
  });

  it("refuses to construct a client from a service-role key", () => {
    expect(() => createWorkerClient({
      backendUrl: "https://example.test",
      anonKey: jwt({ role: "service_role" }),
      accessToken: "user-access-token",
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
    })).toThrow(/service_role_rejected/);
  });
});

describe("settings redaction", () => {
  it("drops worker credentials before a content script can read settings", () => {
    const settings = {
      manualFirstReview: true,
      workerAnonKey: publishable,
      workerEmail: "lane@example.test",
      workerPassword: "lane-password",
      workerAccessToken: "user-access-token",
      workerRefreshToken: "user-refresh-token",
      theme: "warm",
    };
    expect(redactWorkerCredentials(settings)).toEqual({ manualFirstReview: true, theme: "warm" });
    const rejected = normalizeWorkerSettings({
      workerEnabled: true,
      workerBackendUrl: "https://example.test",
      workerAnonKey: secret,
      workerLaneName: "lane-1",
    });
    expect(rejected.ready).toBe(false);
    expect(rejected.configError).toBe("secret_key_rejected");
  });

  it("does not attach a publishable key as the realtime access token", () => {
    const joined = realtimeJoinMessage("1", "user-access-token");
    expect(joined.payload.access_token).toBe("user-access-token");
    expect(realtimeJoinMessage("1", publishable).payload.access_token).toBeUndefined();
    expect(realtimeJoinMessage("1", secret).payload.access_token).toBeUndefined();
    const refreshed = realtimeAccessTokenMessage("2", "user-access-token");
    expect(refreshed).toMatchObject({
      topic: "realtime:etsy_worker:jobs",
      event: "access_token",
      payload: { access_token: "user-access-token" },
      ref: "2",
    });
    expect(realtimeAccessTokenMessage("3", publishable).payload.access_token).toBeUndefined();
    expect(realtimeAccessTokenMessage("3", secret).payload.access_token).toBeUndefined();
  });

  it("asks the lane-safe whoami RPC from the options health client", async () => {
    const seen = [];
    const client = createWorkerClient({
      backendUrl: "https://example.test",
      anonKey: "k",
      accessToken: "user-access-token",
      fetchImpl: async (url) => {
        seen.push(String(url));
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, role: "lane", lane_name: "lane-1", server_time: "2026-09-25T00:00:00.000Z" }),
        };
      },
    });
    const who = await client.laneWhoami();
    expect(who).toMatchObject({ ok: true, role: "lane", lane_name: "lane-1" });
    expect(seen[0]).toContain("/rpc/etsy_worker_lane_whoami");
  });
});
