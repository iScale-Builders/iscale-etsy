import { describe, it, expect } from "vitest";
import {
  formatBadgeCount,
  newSinceExport,
  shouldAutoExport,
  untilNextExport,
  feedItem,
  autoExportOn,
  autoRunOn,
  autoRunMinutes,
  jitteredAutoRunMinutes,
  jitteredBetweenTermsMs,
  blockCooldownMs,
  inBlockCooldown,
} from "../src/core/collection.js";

describe("jitteredBetweenTermsMs (randomized between-terms pause)", () => {
  it("returns the exact base when randomize is off", () => {
    expect(jitteredBetweenTermsMs({ betweenTermsSec: 120 }, () => 0.5)).toBe(120000);
  });
  it("returns 0 when the pause is off (regardless of randomize)", () => {
    expect(jitteredBetweenTermsMs({ betweenTermsSec: 0, randomizeInterval: true, randomizePct: 40 })).toBe(0);
  });
  it("jitters ±randomizePct around the base when randomize is on", () => {
    const s = { betweenTermsSec: 120, randomizeInterval: true, randomizePct: 40 }; // 120000 ±40%
    expect(jitteredBetweenTermsMs(s, () => 0)).toBe(72000); // floor: 120000*0.6
    expect(jitteredBetweenTermsMs(s, () => 1)).toBe(168000); // ceil: 120000*1.4
    expect(jitteredBetweenTermsMs(s, () => 0.5)).toBe(120000); // midpoint
  });
});

describe("post-block cooldown (circuit-breaker backoff)", () => {
  it("blockCooldownMs converts minutes to ms (default 30 → 1.8M)", () => {
    expect(blockCooldownMs({ blockCooldownMin: 30 })).toBe(1800000);
    expect(blockCooldownMs({ blockCooldownMin: 0 })).toBe(0);
    expect(blockCooldownMs({})).toBe(0); // no setting → no cooldown stamp
  });
  it("inBlockCooldown is true only while a future blockedUntil hasn't passed", () => {
    expect(inBlockCooldown({ blockedUntil: 0 }, 1000)).toBe(false);
    expect(inBlockCooldown({ blockedUntil: 5000 }, 1000)).toBe(true);
    expect(inBlockCooldown({ blockedUntil: 5000 }, 5000)).toBe(false); // exactly elapsed
    expect(inBlockCooldown({ blockedUntil: 5000 }, 9000)).toBe(false);
    expect(inBlockCooldown({}, 1000)).toBe(false);
  });
});


describe("formatBadgeCount", () => {
  it("formats counts compactly", () => {
    expect(formatBadgeCount(0)).toBe("");
    expect(formatBadgeCount(7)).toBe("7");
    expect(formatBadgeCount(999)).toBe("999");
    expect(formatBadgeCount(1500)).toBe("1k");
    expect(formatBadgeCount(120000)).toBe("99k+");
  });
});

describe("auto-export trigger", () => {
  it("newSinceExport never goes negative", () => {
    expect(newSinceExport(120, 100)).toBe(20);
    expect(newSinceExport(90, 100)).toBe(0);
  });
  it("shouldAutoExport fires when the count crosses a round multiple of `every`", () => {
    expect(shouldAutoExport(150, { autoExportEvery: 50, lastExportTotal: 100 })).toBe(true); // crossed 150
    expect(shouldAutoExport(149, { autoExportEvery: 50, lastExportTotal: 100 })).toBe(false); // still in the 100–149 block
    expect(shouldAutoExport(528, { autoExportEvery: 500, lastExportTotal: 480 })).toBe(true); // batch jumped past 500
    expect(shouldAutoExport(1431, { autoExportEvery: 500, lastExportTotal: 1366 })).toBe(false); // same 500-block as the watermark
  });
  it("is disabled when autoExportEvery is 0", () => {
    expect(shouldAutoExport(9999, { autoExportEvery: 0, lastExportTotal: 0 })).toBe(false);
  });
  it("untilNextExport counts down, null when disabled", () => {
    expect(untilNextExport(120, { autoExportEvery: 50, lastExportTotal: 100 })).toBe(30);
    expect(untilNextExport(100, { autoExportEvery: 0 })).toBe(null);
  });

  it("untilNextExport counts down to the next round multiple of the collected count", () => {
    expect(untilNextExport(1431, { autoExportEvery: 500, lastExportTotal: 1366 })).toBe(69); // 1500-1431; ignores the ragged watermark
    expect(untilNextExport(100, { autoExportEvery: 50, lastExportTotal: 100 })).toBe(50); // at a multiple → full interval to next
    expect(untilNextExport(150, { autoExportEvery: 50, lastExportTotal: 9999 })).toBe(50); // uses the count, not the watermark
  });

  it("the toggle overrides the threshold: off means no export even with a positive interval", () => {
    expect(autoExportOn({ autoExportEnabled: false, autoExportEvery: 50 })).toBe(false);
    expect(shouldAutoExport(9999, { autoExportEnabled: false, autoExportEvery: 50, lastExportTotal: 0 })).toBe(false);
    expect(untilNextExport(9999, { autoExportEnabled: false, autoExportEvery: 50 })).toBe(null);
  });

  it("legacy settings without the flag stay on (backward compatible)", () => {
    expect(autoExportOn({ autoExportEvery: 500 })).toBe(true);
  });
});

describe("auto-run toggle", () => {
  it("is off unless the toggle is on AND the interval is positive", () => {
    expect(autoRunOn({ autoRunEnabled: true, searchIntervalMin: 30 })).toBe(true);
    expect(autoRunOn({ autoRunEnabled: false, searchIntervalMin: 30 })).toBe(false);
    expect(autoRunOn({ autoRunEnabled: true, searchIntervalMin: 0 })).toBe(false);
  });

  it("falls back to the legacy interval>0 rule when the flag is absent", () => {
    expect(autoRunOn({ searchIntervalMin: 15 })).toBe(true);
    expect(autoRunOn({ searchIntervalMin: 0 })).toBe(false);
  });

  it("autoRunMinutes is the interval when on, 0 when off", () => {
    expect(autoRunMinutes({ autoRunEnabled: true, searchIntervalMin: 45 })).toBe(45);
    expect(autoRunMinutes({ autoRunEnabled: false, searchIntervalMin: 45 })).toBe(0);
  });

  it("jitteredAutoRunMinutes returns the base interval when randomize is off", () => {
    expect(jitteredAutoRunMinutes({ autoRunEnabled: true, searchIntervalMin: 30 }, () => 0.5)).toBe(30);
  });

  it("jitteredAutoRunMinutes jitters ±pct around the base (pintwist formula)", () => {
    const on = { autoRunEnabled: true, searchIntervalMin: 30, randomizeInterval: true, randomizePct: 40 };
    expect(jitteredAutoRunMinutes(on, () => 0)).toBeCloseTo(18); // base*(1-0.40)
    expect(jitteredAutoRunMinutes(on, () => 1)).toBeCloseTo(42); // base*(1+0.40)
    expect(jitteredAutoRunMinutes(on, () => 0.5)).toBeCloseTo(30); // midpoint
  });

  it("jitteredAutoRunMinutes clamps pct to 95 and is 0 when auto-run is off", () => {
    expect(jitteredAutoRunMinutes({ autoRunEnabled: true, searchIntervalMin: 10, randomizeInterval: true, randomizePct: 999 }, () => 0)).toBeCloseTo(0.5);
    expect(jitteredAutoRunMinutes({ autoRunEnabled: false, searchIntervalMin: 30, randomizeInterval: true, randomizePct: 40 }, () => 0)).toBe(0);
  });
});

describe("feedItem", () => {
  it("shapes a compact live-feed entry", () => {
    const item = feedItem({ id: "x", title: "Mug", url: "u", demandText: "In 5 carts", demandValue: 5, isDigital: false, source: "passive_browse", scrapedAt: "2026-06-17T00:00:00Z" });
    expect(item).toEqual({
      id: "x",
      title: "Mug",
      url: "u",
      demandText: "In 5 carts",
      demandValue: 5,
      isDigital: false,
      source: "passive_browse",
      at: "2026-06-17T00:00:00Z",
    });
  });
});
