import { describe, expect, it } from "vitest";
import { buildSearchUrl, extractListingId, normalizeEtsyListingUrl, parseSearchTerms } from "../src/core/etsy-url.js";

describe("etsy-url", () => {
  it("normalizes listing URLs and strips query strings", () => {
    expect(normalizeEtsyListingUrl("https://www.etsy.com/listing/1234567890/cat-mug?click_key=abc")).toBe(
      "https://www.etsy.com/listing/1234567890/cat-mug",
    );
  });

  it("rejects non-Etsy listing URLs", () => {
    expect(normalizeEtsyListingUrl("https://example.com/listing/1234567890/nope")).toBeNull();
  });

  it("extracts listing ids", () => {
    expect(extractListingId("https://etsy.com/listing/9876543210/thing")).toBe("9876543210");
  });

  it("dedupes pasted search terms", () => {
    expect(parseSearchTerms("cat mug\n dog mug,cat mug")).toEqual(["cat mug", "dog mug"]);
  });

  it("builds Etsy search URLs", () => {
    expect(buildSearchUrl("cat mug", 2)).toBe("https://www.etsy.com/search?q=cat+mug&page=2&order=most_relevant");
  });
});

