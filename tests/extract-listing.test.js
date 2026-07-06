import { describe, expect, it } from "vitest";
import { extractListingFromDocument, extractStaticReviewDates, noItemReviews, parseValidReviewDate } from "../src/core/extract-listing.js";

describe("parseValidReviewDate (locale-tolerant, tz-stable — audit M-10)", () => {
  const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);
  it("parses ISO (e.g. a <time datetime>)", () => {
    expect(iso(parseValidReviewDate("2024-03-05"))).toBe("2024-03-05");
    expect(iso(parseValidReviewDate("2024-03-05T11:22:00Z"))).toBe("2024-03-05");
  });
  it("parses 3-letter and FULL month names, comma optional, both orders", () => {
    expect(iso(parseValidReviewDate("Mar 5, 2024"))).toBe("2024-03-05");
    expect(iso(parseValidReviewDate("March 5, 2024"))).toBe("2024-03-05");
    expect(iso(parseValidReviewDate("Mar 5 2024"))).toBe("2024-03-05"); // no comma
    expect(iso(parseValidReviewDate("5 March 2024"))).toBe("2024-03-05"); // D Month
    expect(iso(parseValidReviewDate("Sept 5, 2024"))).toBe("2024-09-05"); // Sept variant
  });
  it("is timezone-stable (UTC) — never shifts the day", () => {
    // UTC midnight → slice(0,10) is the same calendar day regardless of runner tz.
    expect(iso(parseValidReviewDate("Jan 1, 2024"))).toBe("2024-01-01");
  });
  it("rejects rollover and out-of-range years and junk", () => {
    expect(parseValidReviewDate("Feb 30, 2024")).toBe(null);
    expect(parseValidReviewDate("2024-02-30")).toBe(null);
    expect(parseValidReviewDate("Mar 5, 1999")).toBe(null); // before Etsy
    expect(parseValidReviewDate("Reviews 4, 2024")).toBe(null); // not a month
    expect(parseValidReviewDate("")).toBe(null);
  });
});

describe("extractStaticReviewDates — prefers <time datetime> (audit M-10)", () => {
  it("reads machine-readable time attrs in the reviews region", () => {
    document.body.innerHTML =
      '<div id="reviews"><time datetime="2024-03-05">a</time><time datetime="2024-06-20">b</time></div>';
    expect(extractStaticReviewDates(document)).toEqual({ firstReview: "2024-03-05", lastReview: "2024-06-20" });
  });
  it("falls back to full-month text dates when no <time>", () => {
    document.body.innerHTML = '<div id="reviews">Reviewed January 2, 2024 and March 9, 2024</div>';
    expect(extractStaticReviewDates(document)).toEqual({ firstReview: "2024-01-02", lastReview: "2024-03-09" });
  });
});

describe("noItemReviews (hard-stop before opening any review modal)", () => {
  it("true when Etsy explicitly reports listing_rating_count 0", () => {
    expect(noItemReviews({ listingRatingCount: 0, bodyText: "" })).toBe(true);
  });
  it("true on the empty-state copy regardless of count", () => {
    expect(noItemReviews({ listingRatingCount: null, bodyText: "Be the first to review this item" })).toBe(true);
    expect(noItemReviews({ bodyText: "...BE THE FIRST TO REVIEW THIS ITEM..." })).toBe(true);
  });
  it("false when the item has reviews", () => {
    expect(noItemReviews({ listingRatingCount: 12, bodyText: "Reviews for this item (12)" })).toBe(false);
  });
  it("UNKNOWN count is NOT treated as zero (page not loaded yet)", () => {
    expect(noItemReviews({ listingRatingCount: null, bodyText: "" })).toBe(false);
    expect(noItemReviews({})).toBe(false);
    expect(noItemReviews()).toBe(false);
  });
});

describe("extract-listing", () => {
  it("extracts a verified listing document", () => {
    document.body.innerHTML = `
      <link rel="canonical" href="https://www.etsy.com/listing/1234567890/cat-mug" />
      <meta property="og:url" content="https://www.etsy.com/listing/1234567890/cat-mug" />
      <meta property="og:title" content="Cat Mug Handmade Ceramic" />
      <meta property="og:image" content="https://i.etsystatic.com/cat.jpg" />
      <h1 data-buy-box-listing-title="true">Cat Mug Handmade Ceramic</h1>
      <div data-buy-box-region="shop-name-block"><a>Cozy Mug Co</a></div>
      <div data-buy-box-region="price"><p>$24.99</p></div>
      <p>In 12 carts</p>
      <div id="shipping_and_returns"></div>
      <div data-appears-component-name="shipping_and_returns"></div>
    `;

    const listing = extractListingFromDocument(
      document,
      "https://www.etsy.com/listing/1234567890/cat-mug?click_key=abc",
      { source: "batch", searchTerm: "cat mug" },
    );

    expect(listing.found).toBe(true);
    expect(listing.normalizedUrl).toBe("https://www.etsy.com/listing/1234567890/cat-mug");
    expect(listing.shopName).toBe("Cozy Mug Co");
    expect(listing.demandType).toBe("in_carts");
    expect(listing.isDigital).toBe(false);
  });

  it("rejects stale DOM mismatches", () => {
    document.body.innerHTML = `
      <link rel="canonical" href="https://www.etsy.com/listing/9999999999/other" />
      <h1>Wrong item</h1>
    `;

    const listing = extractListingFromDocument(document, "https://www.etsy.com/listing/1234567890/cat-mug");
    expect(listing).toMatchObject({ found: false, reason: "page_content_mismatch" });
  });

  it("LOW: rejects impossible/out-of-range review dates", () => {
    document.body.innerHTML = `<div id="reviews">Feb 30, 2024 then a real one Mar 5, 2024 and Jan 1, 1990</div>`;
    const reviews = extractStaticReviewDates(document);
    // "Feb 30" (rolls to Mar 1) and 1990 (pre-Etsy) dropped; only the Mar 2024 one
    // survives. (date-only string is TZ-sensitive, so match the month, not the day.)
    expect(reviews.firstReview).toBe(reviews.lastReview);
    expect(reviews.firstReview).toMatch(/^2024-03-0[45]$/);
  });
});
