import { describe, expect, it } from "vitest";
import { buildShopUrl, parseShopPage, parseShopTarget } from "../src/core/shop-page.js";

function setBody(html) {
  document.body.innerHTML = html;
  return document;
}

describe("shop page targets", () => {
  it("accepts a shop name or an etsy shop url and rejects anything else", () => {
    expect(parseShopTarget("CoolShop")).toMatchObject({ shop: "CoolShop", page: 1 });
    expect(parseShopTarget("https://www.etsy.com/shop/CoolShop?page=2")).toMatchObject({
      shop: "CoolShop",
      page: 2,
      url: "https://www.etsy.com/shop/CoolShop?page=2",
    });
    expect(buildShopUrl("CoolShop", 1)).toBe("https://www.etsy.com/shop/CoolShop");
    expect(parseShopTarget("https://example.com/shop/CoolShop")).toBeNull();
    expect(parseShopTarget("http://www.etsy.com/shop/CoolShop")).toBeNull();
    expect(parseShopTarget("../CoolShop")).toBeNull();
    expect(parseShopTarget("")).toBeNull();
  });

  it("reads listing cards from a shop page and stops on a captcha", () => {
    const doc = setBody(`
      <a href="/listing/1234567890/blue-mug"><h3>Blue Mug</h3></a>
      <a href="/listing/1234567890/blue-mug">duplicate</a>
    `);
    const page = parseShopPage(doc, "https://www.etsy.com/shop/CoolShop?page=2");
    expect(page.shop).toBe("CoolShop");
    expect(page.page).toBe(2);
    expect(page.block.blocked).toBe(false);
    expect(page.payload.results).toHaveLength(1);
    expect(page.payload.results[0]).toMatchObject({
      listingId: "1234567890",
      page: 2,
      shopName: "CoolShop",
      url: "https://www.etsy.com/listing/1234567890",
    });

    document.title = "Verify you are a human";
    document.body.innerHTML = "<p>attention required</p>";
    expect(parseShopPage(document, "https://www.etsy.com/shop/CoolShop").block).toMatchObject({ blocked: true, reason: "captcha" });
  });

  it("does not treat a shop page that is still loading as an empty search", () => {
    document.title = "CoolShop";
    const doc = setBody("<h1>CoolShop</h1><p>Loading</p>");
    expect(parseShopPage(doc, "https://www.etsy.com/shop/CoolShop").block).toEqual({
      blocked: false,
      reason: null,
      noResults: false,
    });
  });
});
