// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { createWorkerDb } from "./helpers/worker-db.js";

let db;

function json(value) {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

async function call(statement, params = []) {
  const result = await db.query(statement, params);
  return json(result.rows[0].result);
}

const listing = (id, position, page = 1) => ({
  listing_id: id,
  title: `Item ${id}`,
  shop_name: "Shop",
  price: "$12.00",
  price_numeric: 12,
  currency: "USD",
  favorites: 3,
  review_count: 9,
  rating: 4.5,
  sales_signal: "In 2 carts",
  is_bestseller: true,
  is_popular: false,
  is_ad: false,
  tags: ["linen"],
  image_url: "https://example.test/img.jpg",
  listing_url: `https://www.etsy.com/listing/${id}`,
  position,
  page,
  scraped_at: "2026-09-25T03:00:00.000Z",
});

beforeAll(async () => {
  db = await createWorkerDb();
}, 60000);

describe("etsy worker queue", () => {
  it("adds terms with priority and does not duplicate an open term", async () => {
    const first = await call(
      "select etsy_worker_add_terms($1::jsonb, $2::int, $3::int, $4::text) as result",
      [JSON.stringify(["linen apron", "wool scarf"]), 5, 1, "most_relevant"],
    );
    expect(first.ok).toBe(true);
    expect(first.jobs.map((job) => job.action)).toEqual(["inserted", "inserted"]);

    const again = await call(
      "select etsy_worker_add_terms($1::jsonb, $2::int, $3::int, $4::text) as result",
      [JSON.stringify(["Linen Apron"]), 9, 2, "most_relevant"],
    );
    expect(again.jobs[0]).toMatchObject({ action: "updated", priority: 9, id: first.jobs[0].id });

    const open = await db.query("select count(*)::int as n from etsy_worker.jobs where term_norm = 'linen apron' and status = 'pending'");
    expect(open.rows[0].n).toBe(1);
  });

  it("claims the higher priority term and reports term status", async () => {
    const claim = await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-a", 180]);
    expect(claim.ok).toBe(true);
    expect(claim.job.term).toBe("linen apron");
    expect(claim.job.priority).toBe(9);
    expect(claim.job.attempt).toBe(1);

    const status = await call("select etsy_worker_term_status($1::text) as result", ["linen apron"]);
    expect(status).toMatchObject({
      ok: true,
      state: "processing",
      lane: "lane-a",
      pages_done: 0,
      rows: 0,
      total_results: null,
      last_error: null,
    });
  });

  it("uploads a partial page idempotently and exposes those rows before completion", async () => {
    const status = await call("select etsy_worker_term_status($1::text) as result", ["linen apron"]);
    const rows = [listing("1111111111", 1), listing("2222222222", 2)];
    const uploaded = await call(
      "select etsy_worker_upload_results($1::uuid, $2::text, $3::jsonb, $4::int, $5::int, $6::int) as result",
      [status.id, "lane-a", JSON.stringify(rows), 1, 12480, 180],
    );
    expect(uploaded).toMatchObject({ ok: true, stored: 2, listings_uploaded: 2, total_results: 12480 });

    const duplicate = await call(
      "select etsy_worker_upload_results($1::uuid, $2::text, $3::jsonb, $4::int, $5::int, $6::int) as result",
      [status.id, "lane-a", JSON.stringify(rows), 1, 12480, 180],
    );
    expect(duplicate.listings_uploaded).toBe(2);

    const results = await call("select etsy_worker_results($1::text, $2::int, $3::int) as result", ["linen apron", 50, 0]);
    expect(results.job).toMatchObject({ state: "processing", total_results: 12480, rows: 2, lane: "lane-a" });
    expect(results.listings).toHaveLength(2);
    expect(results.listings[0]).toMatchObject({
      listing_id: "1111111111",
      position: 1,
      page: 1,
      currency: "USD",
      favorites: 3,
      is_bestseller: true,
      sales_signal: "In 2 carts",
      total_results: 12480,
    });

    const after = await call("select etsy_worker_term_status($1::text) as result", ["linen apron"]);
    expect(after).toMatchObject({ pages_done: 1, rows: 2, total_results: 12480, state: "processing" });
  });

  it("extends a live lease and refuses upload or complete after it expires", async () => {
    const status = await call("select etsy_worker_term_status($1::text) as result", ["linen apron"]);
    await db.query("update etsy_worker.jobs set lease_expires_at = now() + interval '2 seconds' where id = $1", [status.id]);
    const beat = await call(
      "select etsy_worker_heartbeat($1::text, $2::uuid, $3::jsonb, $4::int) as result",
      ["lane-a", status.id, JSON.stringify({ search_path: "search_box", page: 1 }), 180],
    );
    expect(beat).toMatchObject({ ok: true, extended: true });
    const lease = await db.query("select lease_expires_at > now() + interval '30 seconds' as fresh from etsy_worker.jobs where id = $1", [status.id]);
    expect(lease.rows[0].fresh).toBe(true);

    await db.query("update etsy_worker.jobs set lease_expires_at = now() - interval '1 second' where id = $1", [status.id]);
    const lateUpload = await call(
      "select etsy_worker_upload_results($1::uuid, $2::text, $3::jsonb, $4::int, $5::int, $6::int) as result",
      [status.id, "lane-a", JSON.stringify([listing("3333333333", 3)]), 1, 12480, 180],
    );
    expect(lateUpload).toMatchObject({ ok: false, error: "lease_lost" });
    const lateComplete = await call(
      "select etsy_worker_complete_job($1::uuid, $2::text, $3::jsonb) as result",
      [status.id, "lane-a", JSON.stringify({})],
    );
    expect(lateComplete).toMatchObject({ ok: false, error: "lease_lost" });
    const still = await call("select etsy_worker_term_status($1::text) as result", ["linen apron"]);
    expect(still.state).toBe("processing");
    const count = await db.query("select count(*)::int as n from etsy_worker.listings where job_id = $1", [status.id]);
    expect(count.rows[0].n).toBe(2);
  });

  it("requeues an expired lease idempotently and fails it after max attempts", async () => {
    const first = await call("select etsy_worker_requeue_expired() as result");
    expect(first).toMatchObject({ ok: true, requeued: 1, failed: 0 });
    const second = await call("select etsy_worker_requeue_expired() as result");
    expect(second).toMatchObject({ requeued: 0, failed: 0 });

    let status = await call("select etsy_worker_term_status($1::text) as result", ["linen apron"]);
    expect(status).toMatchObject({ state: "pending", last_error: "lease_expired", attempt: 1, lane: null });

    const again = await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-b", 60]);
    expect(again.job.term).toBe("linen apron");
    expect(again.job.attempt).toBe(2);
    await db.query("update etsy_worker.jobs set lease_expires_at = now() - interval '1 second' where id = $1", [again.job.id]);
    await call("select etsy_worker_requeue_expired() as result");

    const third = await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-b", 60]);
    expect(third.job.attempt).toBe(3);
    await db.query("update etsy_worker.jobs set lease_expires_at = now() - interval '1 second' where id = $1", [third.job.id]);
    const exhausted = await call("select etsy_worker_requeue_expired() as result");
    expect(exhausted).toMatchObject({ requeued: 0, failed: 1 });
    status = await call("select etsy_worker_term_status($1::text) as result", ["linen apron"]);
    expect(status).toMatchObject({ state: "failed", last_error: "lease_expired" });
    const onceMore = await call("select etsy_worker_requeue_expired() as result");
    expect(onceMore).toMatchObject({ requeued: 0, failed: 0 });
  });

  it("completes idempotently and keeps a blocked job out of the pending queue", async () => {
    const added = await call(
      "select etsy_worker_add_terms($1::jsonb, $2::int, $3::int, $4::text) as result",
      [JSON.stringify(["ceramic spoon"]), 1, 1, "most_relevant"],
    );
    let claim = await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-c", 180]);
    if (claim.job.term !== "ceramic spoon") {
      await call(
        "select etsy_worker_complete_job($1::uuid, $2::text, $3::jsonb) as result",
        [claim.job.id, "lane-c", JSON.stringify({})],
      );
      claim = await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-c", 180]);
    }
    expect(claim.job.term).toBe("ceramic spoon");
    const done = await call(
      "select etsy_worker_complete_job($1::uuid, $2::text, $3::jsonb) as result",
      [claim.job.id, "lane-c", JSON.stringify({ phase: "done" })],
    );
    expect(done).toMatchObject({ ok: true, already: false, status: "completed" });
    const doneAgain = await call(
      "select etsy_worker_complete_job($1::uuid, $2::text, $3::jsonb) as result",
      [claim.job.id, "lane-c", JSON.stringify({})],
    );
    expect(doneAgain).toMatchObject({ ok: true, already: true, status: "completed" });
    expect(added.jobs[0].id).toBe(claim.job.id);

    const blockedAdd = await call(
      "select etsy_worker_add_terms($1::jsonb, $2::int, $3::int, $4::text) as result",
      [JSON.stringify(["captcha mug"]), 50, 1, "most_relevant"],
    );
    const blockedClaim = await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-c", 180]);
    expect(blockedClaim.job.term).toBe("captcha mug");
    const failed = await call(
      "select etsy_worker_fail_job($1::uuid, $2::text, $3::text, $4::boolean) as result",
      [blockedClaim.job.id, "lane-c", "captcha:page:1", true],
    );
    expect(failed).toMatchObject({ ok: true, status: "blocked", already: false });
    const failedAgain = await call(
      "select etsy_worker_fail_job($1::uuid, $2::text, $3::text, $4::boolean) as result",
      [blockedClaim.job.id, "lane-c", "captcha:page:1", true],
    );
    expect(failedAgain).toMatchObject({ ok: true, already: true, status: "blocked" });
    await db.query("update etsy_worker.jobs set lease_expires_at = now() - interval '1 minute' where id = $1", [blockedClaim.job.id]);
    const requeue = await call("select etsy_worker_requeue_expired() as result");
    expect(requeue.requeued).toBe(0);
    const blockedStatus = await call("select etsy_worker_term_status($1::text) as result", ["captcha mug"]);
    expect(blockedStatus).toMatchObject({ state: "blocked", lane: "lane-c", last_error: "captcha:page:1" });
    expect(blockedAdd.ok).toBe(true);
  });

  it("search-now inserts above every open job", async () => {
    await call(
      "select etsy_worker_add_terms($1::jsonb, $2::int, $3::int, $4::text) as result",
      [JSON.stringify(["quiet term"]), 20, 1, "most_relevant"],
    );
    const now = await call("select etsy_worker_search_now($1::text, $2::int, $3::text) as result", ["rush term", 1, "most_relevant"]);
    expect(now).toMatchObject({ ok: true, action: "inserted", term: "rush term" });
    expect(now.priority).toBeGreaterThan(20);
    const claim = await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-d", 90]);
    expect(claim.job.term).toBe("rush term");
    expect(claim.job.id).toBe(now.id);
  });

  it("reports fleet health", async () => {
    const health = await call("select etsy_worker_health() as result");
    expect(health.ok).toBe(true);
    expect(health.jobs.pending).toBeGreaterThanOrEqual(1);
    expect(health.workers.some((lane) => lane.lane_name === "lane-d")).toBe(true);
    const missing = await call("select etsy_worker_term_status($1::text) as result", ["not a queued term"]);
    expect(missing).toMatchObject({ ok: false, error: "not_found" });
  });
});
