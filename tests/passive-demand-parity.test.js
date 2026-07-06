import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { DEMAND_PATTERNS, LOW_STOCK_PATTERNS } from "../src/core/demand.js";

// passive.js cannot import demand.js (content scripts have no ES module loader),
// so it carries a hand-mirrored copy. This guards against the two silently
// drifting — which previously dropped the `favorited` and `bought_24h` demand
// types from passively-collected listings.

const here = dirname(fileURLToPath(import.meta.url));
const passiveSrc = readFileSync(join(here, "..", "passive.js"), "utf8");
const demandSrc = readFileSync(join(here, "..", "src", "core", "demand.js"), "utf8");

// Every demand type the canonical parser can emit. If demand.js gains a new
// type, add it to demand.js's parser AND passive.js, then update this list.
const DEMAND_TYPES = ["in_carts", "people_in_cart", "bought_24h", "sold_24h", "views_24h", "favorited"];

describe("passive.js demand parity with src/core/demand.js", () => {
  it("carries every canonical DEMAND_PATTERN", () => {
    for (const pattern of DEMAND_PATTERNS) {
      expect(passiveSrc, `missing DEMAND_PATTERN: ${pattern}`).toContain(pattern.source);
    }
  });

  it("carries every canonical LOW_STOCK_PATTERN", () => {
    for (const pattern of LOW_STOCK_PATTERNS) {
      expect(passiveSrc, `missing LOW_STOCK_PATTERN: ${pattern}`).toContain(pattern.source);
    }
  });

  it("emits the same demand types as the canonical module", () => {
    for (const type of DEMAND_TYPES) {
      expect(demandSrc, `demand.js missing type: ${type}`).toContain(`"${type}"`);
      expect(passiveSrc, `passive.js missing type: ${type}`).toContain(`"${type}"`);
    }
  });
});
