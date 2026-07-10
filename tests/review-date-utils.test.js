import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import "../review-date-utils.js";
import { parseValidReviewDate as parseCoreReviewDate } from "../src/core/extract-listing.js";

const utils = globalThis.iScaleReviewDateUtils;
const packageRoot = existsSync(join(process.cwd(), "manifest.json")) ? process.cwd() : join(process.cwd(), "public-etsy-scraper-v5");

describe("review-date-utils content-script parser", () => {
  it("accepts abbreviated, full-month, day-first, and ISO datetime forms", () => {
    const cases = [
      ["Mar 5, 2024", "2024-03-05"],
      ["March 5, 2024", "2024-03-05"],
      ["5 March 2024", "2024-03-05"],
      ["2024-03-05T12:34:56Z", "2024-03-05"],
    ];
    for (const [input, expected] of cases) {
      expect(utils.parseValidReviewDate(input)?.toISOString().slice(0, 10)).toBe(expected);
      expect(parseCoreReviewDate(input)?.toISOString().slice(0, 10)).toBe(expected);
    }
  });

  it("prefers locale-independent time datetime values and rejects rollover dates", () => {
    document.body.innerHTML = `
      <section id="reviews">
        <time datetime="2024-03-05T00:00:00Z">5 mars 2024</time>
        <p>February 30, 2024</p>
        <p>January 2, 2024</p>
      </section>`;
    expect(utils.extractReviewDatesFromArea(document.getElementById("reviews"))).toEqual(["2024-01-02", "2024-03-05"]);
  });

  it("loads the shared utility before passive.js and leaves no legacy abbreviated-month regexes", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "manifest.json"), "utf8"));
    const listingScript = manifest.content_scripts.find((entry) => entry.matches.includes("https://*.etsy.com/listing/*"));
    expect(listingScript.js).toEqual(["review-date-utils.js", "passive.js"]);

    const passive = readFileSync(join(packageRoot, "passive.js"), "utf8");
    expect(passive).not.toContain("[A-Z][a-z]{2}");
    expect(passive).toContain("extractReviewDatesFromArea");
  });
});
