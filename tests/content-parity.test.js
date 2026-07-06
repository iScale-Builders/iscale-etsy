import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";

// Content scripts (content.js, passive.js) can't import ES modules, so they
// hand-mirror src/core logic. These checks fail if a copy drifts from its
// canonical module — the same pattern as passive-demand-parity.test.js.

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

const contentSrc = read("content.js");
const passiveSrc = read("passive.js");
const searchResultsSrc = read("src/core/search-results.js");
const extractListingSrc = read("src/core/extract-listing.js");

function bothContain(name, a, b, signatures) {
  describe(name, () => {
    for (const sig of signatures) {
      it(`both contain ${JSON.stringify(sig)}`, () => {
        expect(a, "canonical missing").toContain(sig);
        expect(b, "copy missing/drifted").toContain(sig);
      });
    }
  });
}

bothContain("content.js search parse mirrors search-results.js", searchResultsSrc, contentSrc, [
  "closestCard",
  ".currency-value",
  ".currency-symbol",
  "out of 5",
  'aria-label*="review"',
  "data-listing-id",
  "v2-listing-card|listing-link|wt-grid__item|js-merch-stash-check-listing",
  "ad by",
  "advertisement",
  "(\\d{7,12})",
]);

bothContain("passive.js listing capture mirrors extract-listing.js", extractListingSrc, passiveSrc, [
  "data-favorite-listing-id",
  "favorites?|people have this",
  "data-appears-event-data",
  "listing_rating_count",
  "be the first to review this item",
  "digital_delivery",
  "shipping_and_returns",
  "application/ld+json",
  "AggregateOffer",
  "jsonld_has_shipping_origin",
  "digitalVotes >= 2",
  "physicalVotes >= 2",
  // Fields realigned in 5.10.8 — passive.js had drifted and dropped these.
  "This item is unavailable",
  "product_unavailable",
  "og:price:amount",
  "parseCurrency",
  "scarcity_signal",
]);
