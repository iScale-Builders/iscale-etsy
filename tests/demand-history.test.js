import { describe, it, expect } from "vitest";
import {
  makeDemandEntry,
  appendDemandHistory,
  unionDemandHistory,
  coerceDemandHistory,
  MAX_DEMAND_HISTORY,
} from "../src/core/demand-history.js";

describe("makeDemandEntry", () => {
  it("builds an entry with date/timestamp/created_at and coerced value", () => {
    const e = makeDemandEntry({ value: "1,234", type: "in_carts", info: "In 1,234 carts" }, "2026-06-17T12:00:00.000Z");
    expect(e).toEqual({
      date: "2026-06-17",
      timestamp: "2026-06-17T12:00:00.000Z",
      created_at: "2026-06-17T12:00:00.000Z",
      value: 1234,
      type: "in_carts",
      info: "In 1,234 carts",
    });
  });
});

describe("appendDemandHistory", () => {
  it("unshifts a new entry when the last is older than an hour", () => {
    const existing = [{ date: "2026-06-16", timestamp: "2026-06-16T12:00:00.000Z", created_at: "2026-06-16T12:00:00.000Z", value: 10, type: "in_carts", info: "In 10 carts" }];
    const out = appendDemandHistory(existing, { value: 20, type: "in_carts", info: "In 20 carts" }, "2026-06-17T12:00:00.000Z");
    expect(out).toHaveLength(2);
    expect(out[0].value).toBe(20);
    expect(out[1].value).toBe(10);
  });

  it("updates in place (keeping created_at) when last entry is < 1h old", () => {
    const created = "2026-06-17T11:30:00.000Z";
    const existing = [{ date: "2026-06-17", timestamp: created, created_at: created, value: 10, type: "in_carts", info: "In 10 carts" }];
    const out = appendDemandHistory(existing, { value: 12, type: "in_carts", info: "In 12 carts" }, "2026-06-17T12:00:00.000Z");
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe(12);
    expect(out[0].created_at).toBe(created);
    expect(out[0].timestamp).toBe("2026-06-17T12:00:00.000Z");
  });

  it("compares the 1h boundary by epoch, not ISO string (handles non-Z timestamps)", () => {
    // created_at lacks the Z and ms; a string compare would misorder it.
    const existing = [{ date: "2026-06-17", timestamp: "2026-06-17T11:30:00", created_at: "2026-06-17T11:30:00", value: 10 }];
    const out = appendDemandHistory(existing, { value: 12 }, "2026-06-17T12:00:00.000Z");
    expect(out).toHaveLength(1); // < 1h apart -> updated in place
    expect(out[0].value).toBe(12);
  });

  it("does not mutate the input array", () => {
    const existing = [{ created_at: "2026-06-16T12:00:00.000Z", timestamp: "2026-06-16T12:00:00.000Z", value: 1 }];
    const copy = JSON.parse(JSON.stringify(existing));
    appendDemandHistory(existing, { value: 2 }, "2026-06-17T12:00:00.000Z");
    expect(existing).toEqual(copy);
  });

  it("caps at MAX_DEMAND_HISTORY", () => {
    let history = [];
    for (let i = 0; i < MAX_DEMAND_HISTORY + 5; i++) {
      history = appendDemandHistory(history, { value: i }, `2026-01-01T${String(i % 24).padStart(2, "0")}:00:00.000Z`.replace("T24", "T23"));
      // force distinct >1h apart by varying day
      history = appendDemandHistory(history, { value: i }, new Date(Date.UTC(2026, 0, 1 + i, 0, 0, 0)).toISOString());
    }
    expect(history.length).toBeLessThanOrEqual(MAX_DEMAND_HISTORY);
  });
});

describe("unionDemandHistory", () => {
  it("keeps distinct keyless entries instead of collapsing them", () => {
    const a = [{ value: 1, info: "x" }];
    const b = [{ value: 1, info: "x" }];
    expect(unionDemandHistory(a, b)).toHaveLength(2);
  });

  it("merges, de-dupes by created_at, and sorts newest-first", () => {
    const a = [{ created_at: "2026-06-17T00:00:00Z", timestamp: "2026-06-17T00:00:00Z", value: 2 }];
    const b = [
      { created_at: "2026-06-17T00:00:00Z", timestamp: "2026-06-17T00:00:00Z", value: 2 },
      { created_at: "2026-06-16T00:00:00Z", timestamp: "2026-06-16T00:00:00Z", value: 1 },
    ];
    const out = unionDemandHistory(a, b);
    expect(out).toHaveLength(2);
    expect(out[0].value).toBe(2);
    expect(out[1].value).toBe(1);
  });
});

describe("coerceDemandHistory", () => {
  it("handles arrays, JSON strings, and junk", () => {
    expect(coerceDemandHistory([{ value: 1 }])).toHaveLength(1);
    expect(coerceDemandHistory('[{"value":1}]')).toHaveLength(1);
    expect(coerceDemandHistory("not json")).toEqual([]);
    expect(coerceDemandHistory(null)).toEqual([]);
  });
});

describe("appendDemandHistory — in-place update preserves real data (audit LOW-11)", () => {
  const t0 = "2026-06-29T12:00:00.000Z";
  const t1 = "2026-06-29T12:30:00.000Z"; // 30 min later → same <1h window (in-place)
  const existing = [{ date: "2026-06-29", timestamp: t0, created_at: t0, value: 5, type: "cart", info: "5 in carts" }];

  it("a blank re-scrape in the same window does NOT wipe the captured value/info", () => {
    const out = appendDemandHistory(existing, { value: "", type: "", info: "" }, t1);
    expect(out).toHaveLength(1); // in-place, not a new entry
    expect(out[0].value).toBe(5);
    expect(out[0].info).toBe("5 in carts");
    expect(out[0].type).toBe("cart");
  });

  it("a positive re-scrape in the same window still wins", () => {
    const out = appendDemandHistory(existing, { value: "8", type: "cart", info: "8 in carts" }, t1);
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe(8);
    expect(out[0].info).toBe("8 in carts");
  });
});
