import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { detectSearchBlock, parseSearchResults } from "../src/core/search-results.js";
import { bundleFiles } from "../scripts/bundle-content.mjs";

// Content scripts are classic scripts. The committed bundles must match the
// modules, and the manifest must not opt them into ES modules.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const contentSrc = read("content.js");
const passiveSrc = read("passive.js");
const searchResultsSrc = read("src/core/search-results.js");
const extractListingSrc = read("src/core/extract-listing.js");
const manifest = JSON.parse(read("manifest.json"));

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

function topLevelImportExport(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//") && /^(import|export)\b/.test(line));
}

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
  "This item is unavailable",
  "product_unavailable",
  "og:price:amount",
  "parseCurrency",
  "scarcity_signal",
]);

describe("classic search parser matches the module", () => {
  it("keeps the committed bundle identical to a fresh build", () => {
    for (const file of bundleFiles()) {
      expect(read(file.out)).toBe(file.text);
    }
  });

  it("parses the same fixtures as search-results.js", () => {
    const code = read("src/content/search-results.classic.js");
    window.eval(code);
    const fixtures = [
      `<h1>1,000+ results</h1><a href="/listing/1111111111/apron"><h3>Linen apron</h3></a>`,
      `<p>Over 50,000 results</p><a href="/listing/2222222222/scarf">Scarf</a>`,
      `<h1>0 results for linen apron</h1><p>We couldn't find any results.</p>`,
      `<h1>Search</h1><p>Please wait</p>`,
    ];
    const href = "https://www.etsy.com/search?q=linen%20apron";
    const now = "2026-09-25T00:00:00.000Z";
    for (const html of fixtures) {
      document.body.innerHTML = html;
      expect(window.IscaleEtsy.parseSearchResults(document, href, now)).toEqual(parseSearchResults(document, href, now));
      expect(window.IscaleEtsy.detectSearchBlock(document)).toEqual(detectSearchBlock(document));
    }
    expect(searchResultsSrc).toContain("export function parseSearchResults");
    expect(contentSrc).toContain("IscaleEtsy");
    expect(contentSrc).not.toContain("function parseSearchResults(");
  });
});

describe("content scripts stay classic", () => {
  it("rejects type module and top-level import or export", () => {
    const files = new Set();
    for (const entry of manifest.content_scripts) {
      expect(entry.type).toBeUndefined();
      for (const file of entry.js) files.add(file);
    }
    expect(files.size).toBeGreaterThan(0);
    for (const file of files) {
      expect(topLevelImportExport(read(file)), file).toEqual([]);
    }
  });
});
