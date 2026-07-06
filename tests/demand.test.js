import { describe, expect, it } from "vitest";
import { findDemandText, hasGoodDemandIndicator, isOnlyLowStock, parseDemandValue } from "../src/core/demand.js";

describe("demand", () => {
  it("finds demand text in page copy", () => {
    expect(findDemandText("Great gift. In 14 carts right now.")).toBe("In 14 carts");
  });

  it("parses demand values", () => {
    expect(parseDemandValue("32 sold in the last 24 hours")).toEqual({
      demandValue: 32,
      demandType: "sold_24h",
    });
  });

  it("separates low stock from useful demand", () => {
    expect(isOnlyLowStock("Only 2 left")).toBe(true);
    expect(hasGoodDemandIndicator("Only 2 left")).toBe(false);
  });
});

