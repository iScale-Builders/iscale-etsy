// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { JOB_TYPES } from "../src/core/worker-commands.js";
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

beforeAll(async () => {
  db = await createWorkerDb();
}, 60000);

describe("etsy worker command channel", () => {
  it("enqueues each job type and keeps search idempotent", async () => {
    const search = await call("select etsy_worker_enqueue($1::text, $2::jsonb, $3::int) as result", [
      "search",
      JSON.stringify({ term: "linen apron", pages: 1 }),
      4,
    ]);
    expect(search).toMatchObject({ ok: true, type: "search", action: "inserted", subject: "linen apron" });
    const again = await call("select etsy_worker_add_terms($1::jsonb, $2::int, $3::int, $4::text) as result", [
      JSON.stringify(["Linen Apron"]),
      6,
      2,
      "most_relevant",
    ]);
    expect(again.jobs[0]).toMatchObject({ action: "updated", id: search.id, priority: 6 });

    const listings = await call("select etsy_worker_enqueue($1::text, $2::jsonb, $3::int) as result", [
      "scrape-listings",
      JSON.stringify({ urls: ["https://www.etsy.com/listing/1234567890/blue-mug", "https://www.etsy.com/listing/1234567890"] }),
      1,
    ]);
    expect(listings).toMatchObject({ ok: true, type: "scrape-listings", action: "inserted" });
    const sameListings = await call("select etsy_worker_enqueue($1::text, $2::jsonb, $3::int) as result", [
      "scrape-listings",
      JSON.stringify({ urls: ["https://www.etsy.com/listing/1234567890"] }),
      2,
    ]);
    expect(sameListings).toMatchObject({ action: "updated", id: listings.id });

    const shop = await call("select etsy_worker_enqueue($1::text, $2::jsonb, $3::int) as result", [
      "scrape-shop",
      JSON.stringify({ url: "https://www.etsy.com/shop/CoolShop?page=2", pages: 2, visitListings: false }),
      3,
    ]);
    expect(shop).toMatchObject({ ok: true, type: "scrape-shop", subject: "CoolShop", pages: 2 });

    const bad = await call("select etsy_worker_enqueue($1::text, $2::jsonb, $3::int) as result", [
      "nope",
      JSON.stringify({}),
      0,
    ]);
    expect(bad).toMatchObject({ ok: false, error: "unknown_job_type" });
    expect(JOB_TYPES).not.toContain("nope");

    const rejectedUrl = await call("select etsy_worker_enqueue($1::text, $2::jsonb, $3::int) as result", [
      "scrape-listings",
      JSON.stringify({ urls: ["https://example.com/listing/1234567890"] }),
      0,
    ]);
    expect(rejectedUrl).toMatchObject({ ok: false, error: "invalid_listing_url" });
  });

  it("claims params, stores a payload, and reads it back by job id", async () => {
    const statsA = await call("select etsy_worker_enqueue($1::text, $2::jsonb, $3::int) as result", ["collection-stats", "{}", 0]);
    const statsB = await call("select etsy_worker_enqueue($1::text, $2::jsonb, $3::int) as result", ["collection-stats", "{}", 0]);
    expect(statsA.id).not.toBe(statsB.id);

    const claim = await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-cmd", 180]);
    expect(claim.job.type).toBe("search");
    expect(claim.job.params.term).toBe("linen apron");
    expect(claim.job.priority).toBe(6);

    await call("select etsy_worker_complete_job($1::uuid, $2::text, $3::jsonb) as result", [claim.job.id, "lane-cmd", "{}"]);
    const shopClaim = await call("select etsy_worker_claim_job($1::text, $2::int) as result", ["lane-cmd", 180]);
    expect(shopClaim.job.type).toBe("scrape-shop");
    expect(shopClaim.job.params.shop).toBe("CoolShop");

    const payload = await call(
      "select etsy_worker_upload_payload($1::uuid, $2::text, $3::text, $4::jsonb, $5::int) as result",
      [shopClaim.job.id, "lane-cmd", "export", JSON.stringify({ count: 1, format: "csv", csv: "title\nMug" }), 180],
    );
    expect(payload.ok).toBe(true);
    const results = await call("select etsy_worker_job_results($1::uuid, $2::int, $3::int) as result", [shopClaim.job.id, 50, 0]);
    expect(results.job.type).toBe("scrape-shop");
    expect(results.payloads[0].body.csv).toContain("Mug");

    const lost = await call(
      "select etsy_worker_upload_payload($1::uuid, $2::text, $3::text, $4::jsonb, $5::int) as result",
      [shopClaim.job.id, "other-lane", "export", JSON.stringify({ count: 1 }), 180],
    );
    expect(lost).toMatchObject({ ok: false, error: "lease_lost" });

    const lookup = await call("select etsy_worker_lookup($1::text, $2::text) as result", ["scrape-shop", "https://www.etsy.com/shop/CoolShop"]);
    expect(lookup).toMatchObject({ ok: true, id: shopClaim.job.id, type: "scrape-shop", state: "processing" });
  });
});
