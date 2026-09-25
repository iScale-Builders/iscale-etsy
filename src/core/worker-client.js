// PostgREST RPC client for the optional worker backend.
// The base URL and key are always passed in. This file has no project id.

import { classifyApiKey, workerAuthHeaders } from "./worker-auth.js";
import { normalizeBackendUrl } from "./worker-config.js";

export const WORKER_RPC = {
  addTerms: "etsy_worker_add_terms",
  searchNow: "etsy_worker_search_now",
  claimJob: "etsy_worker_claim_job",
  heartbeat: "etsy_worker_heartbeat",
  uploadResults: "etsy_worker_upload_results",
  completeJob: "etsy_worker_complete_job",
  failJob: "etsy_worker_fail_job",
  requeueExpired: "etsy_worker_requeue_expired",
  health: "etsy_worker_health",
  laneWhoami: "etsy_worker_lane_whoami",
  termStatus: "etsy_worker_term_status",
  results: "etsy_worker_results",
  fleetStatus: "etsy_worker_fleet_status",
  enqueue: "etsy_worker_enqueue",
  uploadPayload: "etsy_worker_upload_payload",
  jobStatus: "etsy_worker_job_status",
  jobResults: "etsy_worker_job_results",
  lookup: "etsy_worker_lookup",
};

export function rpcUrl(backendUrl, fn) {
  const base = normalizeBackendUrl(backendUrl);
  if (!base.ok) throw new Error(base.error);
  return `${base.base}/rest/v1/rpc/${fn}`;
}

function redact(text, secrets) {
  let value = String(text ?? "");
  for (const secret of secrets) {
    if (secret) value = value.split(secret).join("[redacted]");
  }
  return value.slice(0, 300);
}

export function createWorkerClient({ fetchImpl, backendUrl, anonKey, accessToken, getAccessToken } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const classified = classifyApiKey(anonKey);
  if (!classified.ok) throw new Error(classified.error);
  const key = classified.key;
  if (typeof fetchFn !== "function") throw new Error("missing_fetch");

  async function bearer() {
    const token = getAccessToken ? await getAccessToken() : accessToken;
    return workerAuthHeaders(key, token);
  }

  async function rpc(fn, body) {
    let headers;
    try {
      headers = await bearer();
    } catch (error) {
      return { ok: false, error: error?.code || error?.message || "missing_access_token" };
    }
    let response;
    try {
      response = await fetchFn(rpcUrl(backendUrl, fn), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          apikey: headers.apikey,
          authorization: headers.authorization,
        },
        body: JSON.stringify(body ?? {}),
      });
    } catch (error) {
      return { ok: false, network: true, error: redact(error?.message || "network_error", [key, headers.authorization]) };
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const message = data?.message || data?.error || data?.hint || `http_${response.status}`;
      return { ok: false, error: redact(message, [key, headers.authorization]), status: response.status };
    }
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
    return { ok: true, result: data };
  }

  return {
    addTerms(terms, priority = 0, pages = 1, sort = "most_relevant") {
      return rpc(WORKER_RPC.addTerms, {
        p_terms: terms,
        p_priority: priority,
        p_pages: pages,
        p_sort: sort,
      });
    },
    searchNow(term, pages = 1, sort = "most_relevant") {
      return rpc(WORKER_RPC.searchNow, { p_term: term, p_pages: pages, p_sort: sort });
    },
    claimJob(laneName, leaseSeconds) {
      return rpc(WORKER_RPC.claimJob, { p_lane_name: laneName, p_lease_seconds: leaseSeconds });
    },
    heartbeat(laneName, jobId, progress, leaseSeconds) {
      return rpc(WORKER_RPC.heartbeat, {
        p_lane_name: laneName,
        p_job_id: jobId || null,
        p_progress: progress || {},
        p_lease_seconds: leaseSeconds,
      });
    },
    uploadResults({ jobId, laneName, listings, page, totalResults, totalResultsRaw, leaseSeconds }) {
      return rpc(WORKER_RPC.uploadResults, {
        p_job_id: jobId,
        p_lane_name: laneName,
        p_listings: listings,
        p_page: page,
        p_total_results: totalResults ?? null,
        p_lease_seconds: leaseSeconds,
        p_total_results_raw: totalResultsRaw ?? null,
      });
    },
    completeJob(jobId, laneName, progress) {
      return rpc(WORKER_RPC.completeJob, {
        p_job_id: jobId,
        p_lane_name: laneName,
        p_progress: progress || {},
      });
    },
    failJob(jobId, laneName, error, blocked = false, extra = {}) {
      return rpc(WORKER_RPC.failJob, {
        p_job_id: jobId,
        p_lane_name: laneName,
        p_error: error || "failed",
        p_blocked: blocked === true,
        p_retryable: extra.retryable === true,
        p_release: extra.release === true,
      });
    },
    requeueExpired() {
      return rpc(WORKER_RPC.requeueExpired, {});
    },
    health() {
      return rpc(WORKER_RPC.health, {});
    },
    laneWhoami() {
      return rpc(WORKER_RPC.laneWhoami, {});
    },
    termStatus(term) {
      return rpc(WORKER_RPC.termStatus, { p_term: term });
    },
    results(term, limit = 500, offset = 0) {
      return rpc(WORKER_RPC.results, { p_term: term, p_limit: limit, p_offset: offset });
    },
    fleetStatus() {
      return rpc(WORKER_RPC.fleetStatus, {});
    },
    enqueue(type, params = {}, priority = 0) {
      return rpc(WORKER_RPC.enqueue, {
        p_type: type,
        p_params: params,
        p_priority: priority,
      });
    },
    uploadPayload({ jobId, laneName, kind, body, leaseSeconds }) {
      return rpc(WORKER_RPC.uploadPayload, {
        p_job_id: jobId,
        p_lane_name: laneName,
        p_kind: kind,
        p_body: body,
        p_lease_seconds: leaseSeconds,
      });
    },
    jobStatus(jobId) {
      return rpc(WORKER_RPC.jobStatus, { p_job_id: jobId });
    },
    jobResults(jobId, limit = 500, offset = 0) {
      return rpc(WORKER_RPC.jobResults, { p_job_id: jobId, p_limit: limit, p_offset: offset });
    },
    lookup(type, subject) {
      return rpc(WORKER_RPC.lookup, { p_type: type, p_subject: subject });
    },
  };
}
