// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ADMIN_ID, AGENT_ID, LANE_ID, createWorkerDb, setUid } from "./helpers/worker-db.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let db;

function json(value) {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

async function call(statement, params = []) {
  const result = await db.query(statement, params);
  return json(result.rows[0].result);
}

const listing = (id, position, extra = {}) => ({
  listing_id: id,
  title: `Item ${id}`,
  shop_name: "Shop",
  price: "$12.00",
  price_numeric: 12,
  currency: "USD",
  position,
  page: 1,
  scraped_at: "2026-09-25T03:00:00.000Z",
  ...extra,
});

beforeAll(async () => {
  db = await createWorkerDb();
}, 60000);

describe("operator auth", () => {
  it("grants execute to authenticated and not to anon or public", async () => {
    const priv = await db.query(`
      select
        has_function_privilege('anon', 'public.etsy_worker_health()'::regprocedure, 'execute') as anon,
        has_function_privilege('authenticated', 'public.etsy_worker_health()'::regprocedure, 'execute') as authenticated,
        has_function_privilege('service_role', 'public.etsy_worker_claim_job(text, integer)'::regprocedure, 'execute') as service
    `);
    expect(priv.rows[0]).toEqual({ anon: false, authenticated: true, service: false });
    const acl = await db.query(`
      select proacl::text as acl
      from pg_proc
      where proname = 'etsy_worker_health' and pronamespace = 'public'::regnamespace
    `);
    expect(String(acl.rows[0].acl || "")).not.toMatch(/(^\{|,)=X\//);
  });

  it("rejects a caller who is not an operator and splits lane and agent roles", async () => {
    await setUid(db, "");
    expect(await call("select etsy_worker_health() as result")).toMatchObject({ ok: false, error: "not_authenticated" });

    await setUid(db, LANE_ID);
    expect(await call(
      "select etsy_worker_add_terms($1::jsonb, $2::int, $3::int, $4::text) as result",
      [JSON.stringify(["auth term"]), 1, 1, "most_relevant"],
    )).toMatchObject({ ok: false, error: "not_authorized" });

    await setUid(db, AGENT_ID);
    const terms = await call(
      "select etsy_worker_add_terms($1::jsonb, $2::int, $3::int, $4::text) as result",
      [JSON.stringify(["zebra scarf", "alpha apron"]), 1, 1, "most_relevant"],
    );
    expect(terms.ok).toBe(true);
    expect(await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-auth", 180])).toMatchObject({
      ok: false,
      error: "not_authorized",
    });

    await setUid(db, LANE_ID);
    expect(await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-auth", 180])).toMatchObject({
      ok: false,
      error: "lane_mismatch",
    });
    const claim = await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-1", 180]);
    expect(claim.ok).toBe(true);
    expect(claim.job.term).toBeTruthy();
    await setUid(db, ADMIN_ID);
  });

  it("lets realtime select jobs only for an authenticated operator", async () => {
    const policy = await db.query(`
      select polroles::regrole[]::text[] as roles, pg_get_expr(polqual, polrelid) as expr
      from pg_policy
      where polrelid = 'etsy_worker.jobs'::regclass
    `);
    expect(policy.rows[0].roles).toEqual(["authenticated"]);
    expect(policy.rows[0].expr).toContain("is_operator");
    const table = await db.query(`
      select
        has_table_privilege('anon', 'etsy_worker.jobs', 'select') as anon,
        has_table_privilege('authenticated', 'etsy_worker.jobs', 'select') as authenticated
    `);
    expect(table.rows[0]).toEqual({ anon: false, authenticated: true });
  });

  it("locks add_terms norms in sorted order", async () => {
    const def = await db.query(`
      select pg_get_functiondef('etsy_worker.etsy_worker_add_terms(jsonb, integer, integer, text)'::regprocedure) as src
    `);
    expect(def.rows[0].src).toMatch(/order by 1/);
    expect(def.rows[0].src).toContain("pg_advisory_xact_lock");
    const migration = readFileSync(join(root, "supabase/migrations/20260925140000_etsy_worker_commands.sql"), "utf8");
    expect(migration).not.toContain("drop function if exists etsy_worker.pick_job");
  });

  it("releases a job without burning the attempt and retries a navigation failure", async () => {
    await setUid(db, ADMIN_ID);
    const added = await call(
      "select etsy_worker_add_terms($1::jsonb, $2::int, $3::int, $4::text) as result",
      [JSON.stringify(["release me"]), 3, 1, "most_relevant"],
    );
    const claim = await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-rel", 180]);
    const job = claim.job.term === "release me" ? claim.job : null;
    expect(job || claim.job).toBeTruthy();
    const target = added.jobs.find((row) => row.term === "release me");
    if (claim.job.id !== target.id) {
      await call("select etsy_worker_complete_job($1::uuid, $2::text, $3::jsonb) as result", [claim.job.id, "lane-rel", "{}"]);
    }
    const owned = claim.job.id === target.id
      ? claim
      : await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-rel", 180]);
    expect(owned.job.id).toBe(target.id);
    const attempt = owned.job.attempt;
    const released = await call(
      "select etsy_worker_fail_job($1::uuid, $2::text, $3::text, $4::boolean, $5::boolean, $6::boolean) as result",
      [owned.job.id, "lane-rel", "stopped", false, false, true],
    );
    expect(released).toMatchObject({ ok: true, status: "pending", released: true });
    const row = await db.query("select status, attempt from etsy_worker.jobs where id = $1", [owned.job.id]);
    expect(row.rows[0]).toMatchObject({ status: "pending", attempt: attempt - 1 });

    const again = await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-rel", 180]);
    const retried = await call(
      "select etsy_worker_fail_job($1::uuid, $2::text, $3::text, $4::boolean, $5::boolean, $6::boolean) as result",
      [again.job.id, "lane-rel", "navigation_failed", false, true, false],
    );
    expect(retried).toMatchObject({ ok: true, status: "pending", retryable: true });
    const after = await db.query("select status, attempt, last_error from etsy_worker.jobs where id = $1", [again.job.id]);
    expect(after.rows[0].status).toBe("pending");
    expect(after.rows[0].attempt).toBe(again.job.attempt);
    expect(after.rows[0].last_error).toBe("navigation_failed");
  });

  it("skips one bad listing and stores every row past 300", async () => {
    await setUid(db, ADMIN_ID);
    await call(
      "select etsy_worker_add_terms($1::jsonb, $2::int, $3::int, $4::text) as result",
      [JSON.stringify(["batch apron"]), 9, 1, "most_relevant"],
    );
    let claim = await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-batch", 180]);
    while (claim.job && claim.job.term !== "batch apron") {
      await call("select etsy_worker_complete_job($1::uuid, $2::text, $3::jsonb) as result", [claim.job.id, "lane-batch", "{}"]);
      claim = await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-batch", 180]);
    }
    const rows = [listing("1234567890", 1), listing("2234567890", 2, { is_bestseller: "not-a-boolean" })];
    for (let i = 0; i < 301; i += 1) rows.push(listing(String(3000000000 + i), i + 3));
    const uploaded = await call(
      "select etsy_worker_upload_results($1::uuid, $2::text, $3::jsonb, $4::int, $5::int, $6::int, $7::text) as result",
      [claim.job.id, "lane-batch", JSON.stringify(rows), 1, 50000, 180, "Over 50,000 results"],
    );
    expect(uploaded.ok).toBe(true);
    expect(uploaded.skipped).toBe(1);
    expect(uploaded.stored).toBe(302);
    expect(uploaded.total_results).toBe(50000);
    expect(uploaded.total_results_raw).toBe("Over 50,000 results");
  });
});
