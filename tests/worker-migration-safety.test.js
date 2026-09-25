// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { ADMIN_ID, AGENT_ID, LANE_ID, setUid } from "./helpers/worker-db.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mig1 = "supabase/migrations/20260925120000_etsy_worker.sql";
const mig2 = "supabase/migrations/20260925140000_etsy_worker_commands.sql";
const mig3 = "supabase/migrations/20260925160000_etsy_worker_auth.sql";

const PUBLIC_RPCS = [
  "etsy_worker_add_terms",
  "etsy_worker_claim_job",
  "etsy_worker_complete_job",
  "etsy_worker_enqueue",
  "etsy_worker_fail_job",
  "etsy_worker_fleet_status",
  "etsy_worker_health",
  "etsy_worker_heartbeat",
  "etsy_worker_job_results",
  "etsy_worker_job_status",
  "etsy_worker_lookup",
  "etsy_worker_lane_whoami",
  "etsy_worker_requeue_expired",
  "etsy_worker_results",
  "etsy_worker_search_now",
  "etsy_worker_term_status",
  "etsy_worker_upload_payload",
  "etsy_worker_upload_results",
];

function sql(relative) {
  return readFileSync(join(root, relative), "utf8");
}

function json(value) {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

let db;

async function call(statement, params = []) {
  const result = await db.query(statement, params);
  return json(result.rows[0].result);
}

async function snapshot() {
  const functions = await db.query(`
    select n.nspname as schema, p.proname,
           has_function_privilege('anon', p.oid, 'execute') as anon_exec,
           has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
           (p.prosrc like '%require_lane%') as has_lane,
           (p.prosrc like '%authed%') as has_authed
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'public' and p.proname like 'etsy\\_worker\\_%' escape e'\\\\')
       or p.proname in ('etsy_worker_not_ours', 'etsyAworker_decoy')
       or (n.nspname = 'etsy_worker' and p.proname in ('require_operator', 'require_lane'))
    order by 1, 2
  `);
  const operators = await db.query("select count(*)::int as n from etsy_worker.operators");
  return { functions: functions.rows, operators: operators.rows[0].n };
}

const listing = (id) => ({
  listing_id: id,
  title: `Item ${id}`,
  shop_name: "Shop",
  price: "$12.00",
  price_numeric: 12,
  currency: "USD",
  position: 1,
  page: 1,
  scraped_at: "2026-09-25T03:00:00.000Z",
});

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table if not exists auth.users (id uuid primary key, email text);
    create or replace function auth.uid() returns uuid
    language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
  `);
  await db.exec(sql(mig1));
  await db.exec(sql(mig2));
  await db.exec(`
    create function public.etsy_worker_not_ours() returns integer language sql as $$ select 1 $$;
    create function public."etsyAworker_decoy"() returns integer language sql as $$ select 2 $$;
  `);
  await db.exec(sql(mig3));
  await db.exec(`
    insert into auth.users (id, email) values
      ('${ADMIN_ID}', 'admin@example.test'),
      ('${LANE_ID}', 'lane@example.test'),
      ('${AGENT_ID}', 'agent@example.test');
    insert into etsy_worker.operators (user_id, role, lane_name) values
      ('${ADMIN_ID}', 'admin', null),
      ('${LANE_ID}', 'lane', 'lane-1'),
      ('${AGENT_ID}', 'agent', null);
  `);
  await setUid(db, ADMIN_ID);
}, 60000);

describe("migration safety", () => {
  it("moves only the known functions and ignores LIKE lookalikes", async () => {
    const decoys = await db.query(`
      select n.nspname as schema, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where p.proname in ('etsy_worker_not_ours', 'etsyAworker_decoy')
      order by p.proname
    `);
    expect(decoys.rows).toEqual([
      { schema: "public", proname: "etsyAworker_decoy" },
      { schema: "public", proname: "etsy_worker_not_ours" },
    ]);
    const names = await db.query(`
      select proname
      from pg_proc
      where pronamespace = 'public'::regnamespace
        and proname like 'etsy\\_worker\\_%' escape e'\\\\'
      order by proname
    `);
    expect(names.rows.map((row) => row.proname)).toEqual([...PUBLIC_RPCS, "etsy_worker_not_ours"].sort());
    const auth = sql(mig3);
    expect(auth).not.toMatch(/like\s+'etsy_worker_%'/);
    expect(auth).toContain("escape e'\\\\'");
  });

  it("treats a second auth migration as a no-op", async () => {
    const before = await snapshot();
    await db.exec(sql(mig3));
    expect(await snapshot()).toEqual(before);
    expect(before.operators).toBe(3);

    const claim = before.functions.find((row) => row.schema === "public" && row.proname === "etsy_worker_claim_job");
    expect(claim).toMatchObject({ anon_exec: false, auth_exec: true, has_lane: true, has_authed: false });
    const gate = before.functions.find((row) => row.schema === "etsy_worker" && row.proname === "require_operator");
    expect(gate.has_authed).toBe(false);
  });

  it("does not let a session variable skip the operator check", async () => {
    const source = await db.query(`
      select prosrc from pg_proc
      where proname = 'require_operator' and pronamespace = 'etsy_worker'::regnamespace
    `);
    expect(source.rows[0].prosrc).not.toMatch(/authed/);
    const impl = await db.query(`
      select has_function_privilege(
        'authenticated',
        'etsy_worker.etsy_worker_claim_job(text, integer)'::regprocedure,
        'execute'
      ) as allowed
    `);
    expect(impl.rows[0].allowed).toBe(false);
    await db.query("select set_config('etsy_worker.authed', '1', false)");
    await setUid(db, "");
    expect(await call("select etsy_worker_health() as result")).toMatchObject({ ok: false, error: "not_authenticated" });
    await setUid(db, ADMIN_ID);
  });

  it("binds a lane user to lane_name and still checks the lease", async () => {
    await setUid(db, AGENT_ID);
    const added = await call(
      "select etsy_worker_add_terms($1::jsonb, $2::int, $3::int, $4::text) as result",
      [JSON.stringify(["bound apron"]), 20, 1, "most_relevant"],
    );
    const jobId = added.jobs.find((row) => row.term === "bound apron").id;

    await setUid(db, LANE_ID);
    expect(await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-2", 180])).toMatchObject({
      ok: false,
      error: "lane_mismatch",
    });
    const claim = await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-1", 180]);
    expect(claim.job.id).toBe(jobId);

    expect(await call(
      "select etsy_worker_upload_results($1::uuid, $2::text, $3::jsonb, $4::int, $5::int, $6::int, $7::text) as result",
      [jobId, "lane-2", JSON.stringify([listing("1234567890")]), 1, 1, 180, "1 result"],
    )).toMatchObject({ ok: false, error: "lane_mismatch" });
    expect(await call(
      "select etsy_worker_complete_job($1::uuid, $2::text, $3::jsonb) as result",
      [jobId, "lane-2", "{}"],
    )).toMatchObject({ ok: false, error: "lane_mismatch" });
    expect(await call(
      "select etsy_worker_fail_job($1::uuid, $2::text, $3::text, $4::boolean, $5::boolean, $6::boolean) as result",
      [jobId, "lane-9", "nope", false, false, false],
    )).toMatchObject({ ok: false, error: "lane_mismatch" });

    await setUid(db, ADMIN_ID);
    expect(await call(
      "select etsy_worker_complete_job($1::uuid, $2::text, $3::jsonb) as result",
      [jobId, "lane-2", "{}"],
    )).toMatchObject({ ok: false, error: "lease_lost" });
    const done = await call(
      "select etsy_worker_complete_job($1::uuid, $2::text, $3::jsonb) as result",
      [jobId, "lane-1", "{}"],
    );
    expect(done.ok).toBe(true);

    await setUid(db, AGENT_ID);
    await call(
      "select etsy_worker_add_terms($1::jsonb, $2::int, $3::int, $4::text) as result",
      [JSON.stringify(["admin lane"]), 21, 1, "most_relevant"],
    );
    await setUid(db, ADMIN_ID);
    const adminClaim = await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-9", 180]);
    expect(adminClaim.ok).toBe(true);
    expect(adminClaim.job.term).toBe("admin lane");
  });

  it("caps one upload_results call at 500 rows", async () => {
    await setUid(db, AGENT_ID);
    const added = await call(
      "select etsy_worker_add_terms($1::jsonb, $2::int, $3::int, $4::text) as result",
      [JSON.stringify(["too many rows"]), 30, 1, "most_relevant"],
    );
    const jobId = added.jobs.find((row) => row.term === "too many rows").id;
    await setUid(db, ADMIN_ID);
    const claim = await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-cap", 180]);
    expect(claim.job.id).toBe(jobId);
    const rows = Array.from({ length: 501 }, (_, index) => listing(String(4000000000 + index)));
    const uploaded = await call(
      "select etsy_worker_upload_results($1::uuid, $2::text, $3::jsonb, $4::int, $5::int, $6::int, $7::text) as result",
      [jobId, "lane-cap", JSON.stringify(rows), 1, 501, 180, "501 results"],
    );
    expect(uploaded).toMatchObject({ ok: false, error: "too_many_rows" });
    const stored = await db.query("select count(*)::int as n from etsy_worker.listings where job_id = $1", [jobId]);
    expect(stored.rows[0].n).toBe(0);
  });

  it("lets a lane user read whoami without the agent health RPC", async () => {
    await setUid(db, LANE_ID);
    const who = await call("select etsy_worker_lane_whoami() as result");
    expect(who.ok).toBe(true);
    expect(who.role).toBe("lane");
    expect(who.lane_name).toBe("lane-1");
    expect(who.server_time).toBeTruthy();
    expect(await call("select etsy_worker_health() as result")).toMatchObject({ ok: false, error: "not_authorized" });

    await setUid(db, AGENT_ID);
    const agent = await call("select etsy_worker_lane_whoami() as result");
    expect(agent).toMatchObject({ ok: true, role: "agent", lane_name: null });
    await setUid(db, "");
    expect(await call("select etsy_worker_lane_whoami() as result")).toMatchObject({ ok: false, error: "not_authenticated" });
    await setUid(db, ADMIN_ID);
  });

  it("ships a read-only preflight and an ordered apply script", async () => {
    const preflight = sql("supabase/preflight-etsy-worker.sql");
    const apply = sql("supabase/apply-etsy-worker.sql");
    const statements = preflight.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
    expect(statements).not.toMatch(/\b(insert|update|delete|create|drop|alter|grant|revoke|truncate)\b/i);
    expect(preflight).toContain("etsy\\_worker\\_%");
    expect(preflight).toContain("supabase_realtime");
    expect(preflight).toContain("'anon'");
    expect(preflight).toContain("'authenticated'");
    expect(preflight).toContain("'service_role'");
    await db.exec(statements);
    expect(apply).toContain("\\ir migrations/20260925120000_etsy_worker.sql");
    expect(apply).toContain("\\ir migrations/20260925140000_etsy_worker_commands.sql");
    expect(apply).toContain("\\ir migrations/20260925160000_etsy_worker_auth.sql");
    expect(apply).toContain("ON_ERROR_STOP");
    expect(apply).not.toMatch(/^\s*begin\s*;/im);
    expect((await snapshot()).operators).toBe(3);
  });

  it("aborts mig1 and mig2 once operators exist", async () => {
    await expect(db.exec(sql(mig1))).rejects.toThrow(/operators already exists/);
    await db.exec("rollback");
    await expect(db.exec(sql(mig2))).rejects.toThrow(/operators already exists/);
    await db.exec("rollback");
    const still = await db.query(`
      select has_function_privilege('anon', 'public.etsy_worker_claim_job(text, integer)'::regprocedure, 'execute') as anon
    `);
    expect(still.rows[0].anon).toBe(false);
    expect((await snapshot()).operators).toBe(3);
  });
});
