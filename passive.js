(function () {
  "use strict";

  if (window.__etsyResearchPassiveRan) return;
  window.__etsyResearchPassiveRan = true;

  // Debug logging for the extraction below. Off by default so normal browsing
  // never spams the page console; flip to true when debugging review extraction.
  const RD_DEBUG = false;
  const rdLog = (...args) => {
    if (RD_DEBUG) console.log(...args);
  };

  // Message the service worker, tolerating an invalidated extension context — after an
  // extension reload/update this content script keeps running in the page but its
  // chrome.runtime is dead; sendMessage then throws SYNCHRONOUSLY ("Extension context
  // invalidated"), which a trailing .catch can't swallow. Guard on chrome.runtime.id and
  // wrap in try/catch so an orphaned script fails silently instead of an uncaught rejection.
  function safeSend(message) {
    try {
      if (!chrome.runtime?.id) return Promise.resolve(null); // orphaned — extension was reloaded
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  // Mirror of src/core/extract-listing.js DEMAND_SELECTORS / UNAVAILABLE_INDICATORS
  // (content scripts can't import ES modules). Keep in sync — content-parity.test.js guards it.
  const DEMAND_SELECTORS = [
    "p.wt-text-title-small.wt-sem-text-critical",
    "p.wt-text-title-01.wt-sem-text-critical",
    "[data-buy-box-region='scarcity'] p",
    "[data-appears-component-name='scarcity_signal'] p",
  ];

  const UNAVAILABLE_INDICATORS = [
    "This item is unavailable",
    "Sorry, this item is unavailable",
    "Sorry, this item is no longer available",
    "This listing has been removed",
    "This item has sold",
    "This item is temporarily unavailable",
  ];

  function extractListing(options = {}) {
    const url = window.location.href.split("?")[0];
    const listingId = url.match(/\/listing\/(\d{7,12})/)?.[1] || null;
    if (!listingId) return null;

    const pageText = document.body?.innerText || document.body?.textContent || "";
    if (UNAVAILABLE_INDICATORS.some((indicator) => pageText.includes(indicator))) {
      return { found: false, reason: "product_unavailable", listingId };
    }

    if (!verifyPageMatchesUrl(listingId)) {
      return { found: false, reason: "page_content_mismatch", listingId };
    }

    const title =
      document.querySelector('h1[data-buy-box-listing-title="true"]')?.textContent?.trim() ||
      document.querySelector("h1")?.textContent?.trim() ||
      "";
    if (!title) return { found: false, reason: "missing_title", listingId };
    if (!verifyTitleMatch(title)) return { found: false, reason: "title_mismatch", listingId };

    const price =
      document.querySelector('[data-buy-box-region="price"] p')?.textContent?.trim() ||
      document.querySelector('meta[property="product:price:amount"]')?.content ||
      document.querySelector('meta[property="og:price:amount"]')?.content ||
      "";

    const shopName =
      document.querySelector('[data-buy-box-region="shop-name-block"] a')?.textContent?.trim() ||
      "";

    const imageUrl = document.querySelector('meta[property="og:image"]')?.content || "";
    const demandText = findDemandText(
      [
        ...DEMAND_SELECTORS.map((selector) => document.querySelector(selector)?.textContent || ""),
        document.querySelector(".cart-col")?.textContent || "",
        document.querySelector("[data-buy-box-region]")?.textContent || "",
        pageText,
      ].join("\n"),
    );
    const demand = parseDemandValue(demandText);
    const digital = detectDigitalVsPhysical();
    const reviews = extractStaticReviewDatesLite();
    const now = new Date().toISOString();

    return {
      found: true,
      id: `listing_${listingId}`,
      url,
      normalizedUrl: url,
      listingId,
      title,
      price,
      priceNumeric: parsePrice(price),
      currency: parseCurrency(price),
      shopName,
      imageUrl,
      demandText,
      demandType: demand.demandType,
      demandValue: demand.demandValue,
      hasDemandIndicator: !!demandText && hasGoodDemandIndicator(demandText) && !isOnlyLowStock(demandText),
      favorites: extractFavorites(),
      reviewCount: extractReviewCount(),
      // Manual visits never record a first-review date — only the automation path
      // (listing.extract), which opens the reviews modal and paginates, can find
      // the true oldest review. lastReview (newest, page 1) is reliable statically.
      firstReview: "",
      lastReview: reviews.lastReview,
      isDigital: digital.isDigital,
      digitalSignals: digital.signals,
      source: options.source || "manual",
      searchTerm: options.searchTerm || "",
      jobId: options.jobId || "",
      deleted: false,
      firstSeenAt: now,
      lastSeenAt: now,
      scrapedAt: now,
    };
  }

  // Mirror of src/core/extract-listing.js favorites/review capture (content
  // scripts cannot import ES modules). Keep in sync with that module.
  function extractFavorites() {
    const selectors = ["[data-favorite-listing-id]", 'button[aria-label*="favorite"]', ".wt-text-caption", ".wt-text-body-01"];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const text = el.textContent || el.getAttribute("aria-label") || "";
        const match = text.match(/(\d[\d,]*)\s*(?:favorites?|people have this)/i);
        if (match) return Number.parseInt(match[1].replace(/,/g, ""), 10);
      }
    }
    return 0;
  }

  function extractReviewCount() {
    for (const el of document.querySelectorAll("[data-appears-event-data]")) {
      try {
        const data = JSON.parse(el.getAttribute("data-appears-event-data"));
        if (data && data.listing_rating_count != null) {
          const n = Number.parseInt(data.listing_rating_count, 10);
          if (!Number.isNaN(n)) return n;
        }
      } catch {
        // Malformed JSON — try the next element.
      }
    }
    return 0;
  }

  // Lightweight static newest/oldest from page-1 text only — used for the manual
  // path's lastReview. (The automation path uses the extractReviewDates logic below.)
  function extractStaticReviewDatesLite() {
    const body = document.body?.innerText || "";
    if (/be the first to review this item/i.test(body)) return { firstReview: "None", lastReview: "None" };
    const region =
      document.getElementById("reviews") ||
      document.querySelector('[data-appears-component-name="listing_page_reviews"]') ||
      document.querySelector('[id*="review"]');
    if (!region) return { firstReview: "", lastReview: "" };
    const text = region.innerText || "";
    const matches = text.match(/[A-Z][a-z]{2} \d{1,2}, \d{4}|\d{1,2} [A-Z][a-z]{2}, \d{4}/g);
    if (!matches || matches.length === 0) return { firstReview: "", lastReview: "" };
    const dates = matches.map((d) => new Date(d)).filter((d) => !Number.isNaN(d.getTime()));
    if (dates.length === 0) return { firstReview: "", lastReview: "" };
    dates.sort((a, b) => a - b);
    return { firstReview: dates[0].toISOString().slice(0, 10), lastReview: dates[dates.length - 1].toISOString().slice(0, 10) };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ error: "unauthorized" });
      return true;
    }
    if (message?.action === "listing.extract") {
      const listing = extractListing(message.input || {});
      if (!listing || listing.found === false) {
        sendResponse({ listing });
        return true;
      }
      // Automation path: get the TRUE first-review date using the battle-tested logic —
      // check the page, open the reviews modal if there is one, and paginate to the
      // oldest review. forceModal=true so we always try the modal.
      extractReviewDates(true)
        .then((review) => {
          if (review && review.firstReviewDate) listing.firstReview = review.firstReviewDate;
          if (review && review.lastReviewDate) listing.lastReview = review.lastReviewDate;
          sendResponse({ listing });
        })
        .catch(() => sendResponse({ listing }));
      return true;
    }
    sendResponse({ error: "unknown_action" });
    return true;
  });

  setTimeout(async () => {
    const listing = extractListing();
    if (!listing || listing.found === false) return;
    // Manual browsing skips first-review by default. If the user opted in
    // (manualFirstReview), run the same modal extraction the automation uses.
    try {
      const res = await safeSend({ action: "settings.get" });
      if (res?.ok && res.result?.manualFirstReview) {
        const review = await extractReviewDates(true);
        if (review?.firstReviewDate) listing.firstReview = review.firstReviewDate;
        if (review?.lastReviewDate) listing.lastReview = review.lastReviewDate;
      }
    } catch {
      // settings unavailable — keep the default (no first-review on manual browse).
    }
    safeSend({ action: "listing.savePassive", input: { listing } });
  }, 1500);

  function verifyPageMatchesUrl(listingId) {
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") || "";
    const ogUrl = document.querySelector('meta[property="og:url"]')?.getAttribute("content") || "";
    const favoriteId = document.querySelector("[data-favorite-listing-id]")?.getAttribute("data-favorite-listing-id") || "";
    return canonical.includes(`/listing/${listingId}`) || ogUrl.includes(`/listing/${listingId}`) || favoriteId === listingId;
  }

  function verifyTitleMatch(title) {
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim().toLowerCase();
    if (!ogTitle) return true;
    const normalized = title.trim().toLowerCase();
    return ogTitle.includes(normalized.slice(0, 30)) || normalized.includes(ogTitle.slice(0, 30));
  }

  // NOTE: content scripts cannot import ES modules, so the demand logic below is
  // a hand-mirrored copy of src/core/demand.js. tests/passive-demand-parity.test.js
  // asserts the patterns and demand types here stay identical to the canonical
  // module — keep them in sync, or that test fails.
  const DEMAND_PATTERNS = [
    /In\s+(\d+\+?)\s+carts?/i,
    /(\d+\+?)\s+people\s+have\s+this\s+in\s+their\s+cart/i,
    /In\s+demand\.?\s*(\d+\+?)?\s*people\s+bought\s+this/i,
    /(\d+\+?)\s+sold\s+in\s+(?:the\s+)?last\s+24\s+hours/i,
    /(\d+\+?)\s+views?\s+in\s+(?:the\s+)?last\s+24\s+hours/i,
    /(\d+\+?)\s+people\s+bought\s+this/i,
    /In\s+demand/i,
    /Selling\s+fast/i,
    /Popular\s+item/i,
    /Bestseller/i,
  ];

  const LOW_STOCK_PATTERNS = [
    /^only \d+ left/i,
    /^low in stock/i,
    /^\d+ left in stock/i,
    /^almost gone/i,
    /^limited quantity/i,
  ];

  function findDemandText(text) {
    const source = String(text || "");
    for (const pattern of DEMAND_PATTERNS) {
      const match = source.match(pattern);
      if (match) return match[0];
    }
    return "";
  }

  function hasGoodDemandIndicator(text) {
    if (!text) return false;
    return (
      /in \d+\+? carts?/i.test(text) ||
      /sold in (?:the )?last/i.test(text) ||
      /views in (?:the )?last/i.test(text) ||
      /people bought this/i.test(text) ||
      /in demand/i.test(text) ||
      /selling fast/i.test(text) ||
      /popular item/i.test(text) ||
      /bestseller/i.test(text)
    );
  }

  function isOnlyLowStock(text) {
    if (!text) return false;
    return LOW_STOCK_PATTERNS.some((pattern) => pattern.test(text));
  }

  function parseDemandValue(text) {
    if (!text) return { demandValue: 0, demandType: "" };

    const patterns = [
      [/In\s+(\d+)\+?\s+carts/i, "in_carts"],
      [/(\d[\d,]*)\s*people\s+have\s+this\s+in\s+their\s+cart/i, "people_in_cart"],
      [/In\s+demand\.?\s*(\d[\d,]*)\s*people\s+bought\s+this/i, "bought_24h"],
      [/(\d[\d,]*)\s*sold\s+in\s+(?:the\s+)?last\s+24\s+hours/i, "sold_24h"],
      [/(\d[\d,]*\+?)\s*views?\s+in\s+(?:the\s+)?last\s+24\s+hours/i, "views_24h"],
      [/(\d[\d,]*)\s*favorited\s+this/i, "favorited"],
    ];

    for (const [regex, type] of patterns) {
      const match = text.match(regex);
      if (match) {
        return { demandValue: Number.parseInt(match[1].replace(/[,+]/g, ""), 10), demandType: type };
      }
    }

    return hasGoodDemandIndicator(text) ? { demandValue: 0, demandType: "other" } : { demandValue: 0, demandType: "" };
  }

  // Mirror of src/core/extract-listing.js detectDigitalVsPhysical (JSON-LD offer
  // signals + ≥2-vote consensus). Keep in sync with that module.
  function detectDigitalVsPhysical() {
    const signals = {
      jsonld_offer_type: null,
      jsonld_has_shipping_origin: null,
      has_digital_delivery_div: !!document.getElementById("digital_delivery"),
      has_digital_delivery_component: !!document.querySelector('[data-appears-component-name="digital_delivery"]'),
      has_shipping_and_returns_div: !!document.getElementById("shipping_and_returns"),
      has_shipping_and_returns_component: !!document.querySelector('[data-appears-component-name="shipping_and_returns"]'),
      verdict: null,
      confidence: "low",
    };

    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        if (data?.["@type"] === "Product" && data.offers) {
          signals.jsonld_offer_type = data.offers["@type"] || null;
          signals.jsonld_has_shipping_origin = !!(data.offers.shippingDetails && data.offers.shippingDetails.shippingOrigin);
          break;
        }
      } catch {
        // Ignore invalid structured data.
      }
    }

    const digitalVotes =
      (signals.jsonld_offer_type === "Offer" && signals.jsonld_has_shipping_origin === false ? 1 : 0) +
      (signals.has_digital_delivery_div ? 1 : 0) +
      (signals.has_digital_delivery_component ? 1 : 0);
    const physicalVotes =
      (signals.jsonld_offer_type === "AggregateOffer" || signals.jsonld_has_shipping_origin === true ? 1 : 0) +
      (signals.has_shipping_and_returns_div ? 1 : 0) +
      (signals.has_shipping_and_returns_component ? 1 : 0);

    if (digitalVotes >= 2 && physicalVotes === 0) {
      signals.verdict = true;
      signals.confidence = digitalVotes === 3 ? "high" : "medium";
    } else if (physicalVotes >= 2 && digitalVotes === 0) {
      signals.verdict = false;
      signals.confidence = physicalVotes === 3 ? "high" : "medium";
    } else if (digitalVotes >= 2 && physicalVotes >= 2) {
      signals.confidence = "conflict";
    }

    return { isDigital: signals.verdict, signals };
  }

  function parsePrice(value) {
    const match = String(value || "").match(/[\d,.]+/);
    if (!match) return null;
    const raw = match[0];
    if (/^\d+,\d{2}$/.test(raw)) return Number.parseFloat(raw.replace(",", "."));
    return Number.parseFloat(raw.replace(/,/g, ""));
  }

  // Mirror of src/core/extract-listing.js parseCurrency. Keep in sync.
  function parseCurrency(value) {
    const text = String(value || "");
    if (text.includes("€")) return "EUR";
    if (text.includes("£")) return "GBP";
    if (text.includes("$")) return "USD";
    return "";
  }

  // ----------------------------------------------------------------------------
  // First-review extraction — battle-tested logic carried over from an earlier
  // private edition of this scraper. It checks the page, then opens + paginates
  // the reviews modal to find the true oldest review. Deliberately kept verbatim
  // (it encodes years of Etsy DOM edge cases); prefer additive changes over
  // rewrites here.
  // ----------------------------------------------------------------------------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function randomInRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

function getReviewCount() {
  rdLog("[Review Dates] Getting LISTING review count (not shop)...");

  // First priority: Look for data attributes with listing_rating_count
  // The modal contains: data-appears-event-data='{"listing_rating_count":11,"shop_rating_count":424,...}'
  const dataElements = document.querySelectorAll("[data-appears-event-data]");
  for (const el of dataElements) {
    try {
      const dataStr = el.getAttribute("data-appears-event-data");
      const data = JSON.parse(dataStr);
      if (data.listing_rating_count !== undefined) {
        const count = parseInt(data.listing_rating_count, 10);
        rdLog(
          `[Review Dates] Found LISTING review count from data attribute: ${count} (shop has ${data.shop_rating_count || "unknown"})`,
        );
        return count;
      }
    } catch {
      // Continue to next element
    }
  }

  // Second priority: Look for review header with class "review-header-text"
  // Format: "Reviews for this item (683)" or "Reviews for this shop (1,234)"
  const reviewHeader = document.querySelector(".review-header-text, h2[class*='review-header']");
  if (reviewHeader) {
    const text = reviewHeader.innerText || "";
    // Match "Reviews for this item (683)" or similar patterns
    const match = text.match(/\((\d[\d,]*)\)/);
    if (match) {
      const count = parseInt(match[1].replace(/,/g, ""), 10);
      rdLog(`[Review Dates] Found review count from review-header-text: ${count}`);
      return count;
    }
  }

  // Third priority: Look for the listing reviews section specifically
  const listingReviewsSection =
    document.getElementById("reviews") ||
    document.getElementById("same-listing-reviews") ||
    document.querySelector('[data-selector="reviews-region"]');

  if (listingReviewsSection) {
    // Look for review count within the listing reviews section only
    const text = listingReviewsSection.innerText || "";
    const match = text.match(/(\d[\d,]*)\s*reviews?/i);
    if (match) {
      const count = parseInt(match[1].replace(/,/g, ""), 10);
      rdLog(`[Review Dates] Found review count from listing section: ${count}`);
      return count;
    }
  }

  // Fourth priority: Try JSON-LD structured data (usually listing-specific)
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent);
      if (data.aggregateRating?.reviewCount) {
        const count = parseInt(data.aggregateRating.reviewCount, 10);
        rdLog(`[Review Dates] Found review count from JSON-LD: ${count}`);
        return count;
      }
    } catch {
      // Ignore JSON parse errors
    }
  }

  rdLog("[Review Dates] Could not find listing review count");
  return 0;
}

// Helper: Extract dates from currently visible reviews (static DOM)
function extractStaticReviewDates() {
  const result = { firstReviewDate: null, lastReviewDate: null };

  // Try multiple selectors for the review section
  const reviewHeader = document.querySelector(".review-header-text, h2[class*='review-header']");
  rdLog("[Review Dates] Static: reviewHeader found:", !!reviewHeader);

  const reviewSection =
    (reviewHeader ? reviewHeader.closest("section, div[class*='review']") : null) ||
    document.getElementById("reviews") ||
    document.getElementById("same-listing-reviews") ||
    document.querySelector('[data-selector="reviews-region"]') ||
    document.querySelector('[class*="reviews-region"], [class*="listing-page-reviews"]');

  rdLog("[Review Dates] Static: reviewSection found:", !!reviewSection);

  if (!reviewSection) {
    rdLog("[Review Dates] No review section found for static extraction");
    // Fallback: try to find dates anywhere in the page with review context
    const allText = document.body.innerText;
    const dateRegex = /[A-Z][a-z]{2} \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2},? \d{4}/g;
    const allDates = allText.match(dateRegex);
    rdLog("[Review Dates] Fallback dates found in page:", allDates?.length || 0);
    return result;
  }

  const dateRegex = /[A-Z][a-z]{2} \d{1,2}, \d{4}|\d{1,2} [A-Z][a-z]{2}, \d{4}/g;
  const textContent = reviewSection.innerText;
  const foundDates = textContent.match(dateRegex);
  rdLog(
    "[Review Dates] Static: dates found in section:",
    foundDates?.length || 0,
    foundDates,
  );

  if (foundDates && foundDates.length > 0) {
    const parsedDates = foundDates.map((d) => new Date(d)).filter((d) => !isNaN(d));
    if (parsedDates.length > 0) {
      parsedDates.sort((a, b) => a - b);
      result.firstReviewDate = parsedDates[0].toISOString().slice(0, 10);
      result.lastReviewDate = parsedDates[parsedDates.length - 1].toISOString().slice(0, 10);
      rdLog(
        `[Review Dates] Static extraction found dates: first=${result.firstReviewDate}, last=${result.lastReviewDate}`,
      );
    }
  } else {
    rdLog("[Review Dates] Static: No dates matched regex in review section");
  }

  return result;
}

function shouldTrustStaticReviewDates(reviewCount, staticDates) {
  if (!staticDates?.firstReviewDate || !staticDates?.lastReviewDate) return false;
  return reviewCount > 0 && reviewCount <= 3;
}

// Helper: Wait for element to appear in DOM
async function waitForElement(selector, timeout = 5000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const element = document.querySelector(selector);
    if (element && element.offsetParent !== null) {
      return element;
    }
    await sleep(100);
  }

  return null;
}

// Helper: Find all review-related buttons/links on the page
function findReviewButtons() {
  const allButtons = document.querySelectorAll("button, a");
  const candidates = [];

  for (const btn of allButtons) {
    const text = (btn.innerText || "").toLowerCase();
    const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
    const href = btn.getAttribute("href") || "";

    if (text.includes("review") || ariaLabel.includes("review") || href.includes("review")) {
      candidates.push({
        text: btn.innerText?.substring(0, 50),
        element: btn,
      });
    }
  }
  return candidates;
}

// Helper: Open "See all reviews" modal
async function openReviewsModal() {
  rdLog("[Review Dates] Attempting to open LISTING reviews modal (not shop reviews)...");

  // First, scroll to the LISTING reviews section (not shop reviews)
  // Listing reviews have specific IDs and data attributes
  // Shop reviews are typically in a different section further down
  const listingReviewsSections = [
    document.getElementById("reviews"),
    document.getElementById("same-listing-reviews"),
    document.querySelector('[data-selector="reviews-region"]'),
    document.querySelector("[data-reviews-section-region]"),
    document.querySelector("#listing-page-reviews"),
    document.querySelector('[data-region="listing-reviews"]'),
  ].filter(Boolean);

  let reviewsSection = null;
  for (const section of listingReviewsSections) {
    // Skip if this section appears to be shop reviews
    const sectionText = section.innerText?.toLowerCase() || "";
    const isShopReviews =
      sectionText.includes("shop reviews") ||
      sectionText.includes("seller reviews") ||
      section.id?.includes("shop");
    if (!isShopReviews) {
      reviewsSection = section;
      rdLog(
        "[Review Dates] Found listing reviews section:",
        section.id || section.className?.substring(0, 50),
      );
      break;
    }
  }

  if (reviewsSection) {
    rdLog("[Review Dates] Scrolling to LISTING reviews section...");
    reviewsSection.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(randomInRange(800, 1200));
  } else {
    rdLog(
      "[Review Dates] Could not find specific listing reviews section, scrolling to page reviews area",
    );
    // Fallback: scroll partway down the page where listing reviews usually are
    window.scrollTo({ top: 1500, behavior: "smooth" });
    await sleep(randomInRange(800, 1200));
  }

  // Get review button candidates
  const candidates = findReviewButtons();

  // GUARD: Reject star-rating elements that look like review buttons
  function isStarRatingElement(el) {
    const text = (el.innerText || el.getAttribute("aria-label") || "").toLowerCase();
    if (text.includes("out of") && text.includes("star")) return true;
    if (/^\d\s*(out of|\/)\s*\d\s*star/i.test(text)) return true;
    if (el.closest('[data-rating], [class*="star-rating"], [class*="starRating"]')) return true;
    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
    if (aria.includes("star") && !aria.includes("review")) return true;
    return false;
  }

  // Try to find review modal trigger button
  // IMPORTANT: We want LISTING reviews, not SHOP reviews
  const allButtons = document.querySelectorAll("button, a");
  let reviewButton = null;

  // Priority 0: "View/see all reviews for this item" (listing-specific)
  for (const btn of allButtons) {
    if (isStarRatingElement(btn)) continue;
    const text = (btn.innerText || btn.getAttribute("aria-label") || "").toLowerCase();
    if (text.includes("reviews for this item") || text.includes("reviews for this listing")) {
      reviewButton = btn;
      break;
    }
  }

  // Priority 1: Button with "see all"/"view all" and "review" but NOT "shop"
  if (!reviewButton) {
    for (const btn of allButtons) {
      if (isStarRatingElement(btn)) continue;
      const text = (btn.innerText || btn.getAttribute("aria-label") || "").toLowerCase();
      if (text.includes("shop review") || text.includes("seller review")) continue;
      if ((text.includes("see all") || text.includes("view all")) && text.includes("review")) {
        reviewButton = btn;
        break;
      }
    }
  }

  // Priority 2: Link/button with JUST "X reviews" text
  if (!reviewButton) {
    for (const btn of allButtons) {
      if (isStarRatingElement(btn)) continue;
      const text = (btn.innerText || "").trim();
      const isFilterButton = /^[A-Za-z\s]+\s*\(\d+\)$/.test(text);
      if (isFilterButton) continue;
      if (/^\d[\d,]*\s*reviews?$/i.test(text)) {
        reviewButton = btn;
        break;
      }
    }
  }

  // Priority 3: "See/View all X reviews" patterns (but NOT shop)
  if (!reviewButton) {
    for (const btn of allButtons) {
      if (isStarRatingElement(btn)) continue;
      const text = (btn.innerText || "").toLowerCase();
      if (text.includes("shop review") || text.includes("seller review")) continue;
      if (/(see|view)\s*(all\s*)?\d*\s*reviews?/i.test(text)) {
        reviewButton = btn;
        break;
      }
    }
  }

  // Priority 4: From candidates - any link/button containing "reviews" but NOT a filter or shop
  if (!reviewButton && candidates.length > 0) {
    for (const cand of candidates) {
      if (cand.element && isStarRatingElement(cand.element)) continue;
      const text = (cand.text || "").trim();
      const lowerText = text.toLowerCase();
      if (lowerText.includes("shop review") || lowerText.includes("seller review")) continue;
      const isFilterButton = /^[A-Za-z\s]+\s*\(\d+\)$/.test(text);
      if (isFilterButton) continue;
      if (/^reviews?$/i.test(text)) continue;
      if (cand.element) {
        reviewButton = cand.element;
        break;
      }
    }
  }

  // Priority 5: a[href="#reviews"] specifically (but NOT star links)
  if (!reviewButton) {
    const reviewHeaders = document.querySelectorAll('a[href="#reviews"], a[href*="reviews"]');
    for (const btn of reviewHeaders) {
      if (isStarRatingElement(btn)) continue;
      const text = (btn.innerText || "").trim();
      const isFilterButton = /^[A-Za-z\s]+\s*\(\d+\)$/.test(text);
      if (isFilterButton) continue;
      if (text.toLowerCase().includes("review")) {
        reviewButton = btn;
        break;
      }
    }
  }

  // Priority 6: Any candidate with review count pattern (but NOT star ratings)
  if (!reviewButton && candidates.length > 0) {
    for (const cand of candidates) {
      if (cand.element && isStarRatingElement(cand.element)) continue;
      const text = cand.text || "";
      if (/\d+.*review/i.test(text) && cand.element) {
        reviewButton = cand.element;
        break;
      }
    }
  }

  // (A prior star-rating click target was dropped here — it opened the wrong modal.)

  // Priority 8: Any non-filter candidate (but NOT star ratings)
  if (!reviewButton && candidates.length > 0) {
    for (const cand of candidates) {
      if (cand.element && isStarRatingElement(cand.element)) continue;
      const text = (cand.text || "").trim();
      const isFilterButton = /^(?!Reviews)[A-Za-z]+\s*\(\d+\)$/.test(text);
      if (isFilterButton || !text) continue;
      if (cand.element) {
        reviewButton = cand.element;
        break;
      }
    }
  }

  // Priority 9: Last resort - first candidate that is NOT a star rating
  if (!reviewButton && candidates.length > 0) {
    const firstValid = candidates.find((c) => c.element && !isStarRatingElement(c.element));
    if (firstValid) {
      reviewButton = firstValid.element;
    }
  }

  if (!reviewButton) {
    rdLog("[Review Dates] Could not find reviews modal button");
    return false;
  }

  // SAFETY GUARD: the reviews trigger opens an IN-PAGE modal. If the chosen
  // element is a link that would navigate AWAY (e.g. a reviewer profile
  // /people/<id>?ref=l_review — whose href contains "review" and so slipped
  // through findReviewButtons), do NOT click it. Navigating away breaks the
  // scrape and yanks the user off the listing. Bail to the static fallback.
  if (reviewButton.tagName === "A") {
    const href = reviewButton.getAttribute("href") || "";
    const navigatesAway = href && !href.startsWith("#") && !/\/listing\/\d/.test(href);
    if (navigatesAway) {
      rdLog("[Review Dates] Rejecting nav-away review link (would leave page):", href);
      return false;
    }
  }

  // Record which button we clicked. The window global is INTENTIONAL debug
  // telemetry: extractReviewDates() reads it back into result.audit so the
  // scrape record says how the modal was opened (invaluable when Etsy's DOM
  // shifts). Underscore-prefixed to stay out of Etsy's way; page scripts
  // overwriting it only degrades the audit note, never the scrape.
  const buttonText = (reviewButton.innerText || "").substring(0, 50);
  const buttonTag = reviewButton.tagName;
  window.__lastReviewButtonText = `<${buttonTag}> "${buttonText}"`;
  rdLog(`[Review Dates] Found review button: <${buttonTag}> "${buttonText}"`);

  // Snapshot DOM before click for change detection
  const preClickDialogs = new Set(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'));

  // Scroll button into view and click
  reviewButton.scrollIntoView({ behavior: "smooth", block: "center" });
  await sleep(randomInRange(300, 500));
  rdLog("[Review Dates] Clicking review button...");
  reviewButton.click();

  // Wait for modal to appear
  await sleep(randomInRange(500, 800));

  const modalSelectors = [
    '[role="dialog"]', '[aria-modal="true"]',
    ".wt-overlay", ".wt-overlay__modal", ".wt-modal",
    "[data-reviews-modal]", '[data-appears-component-name*="review"]',
    '.overlay-region [role="region"]',
    ".reviews-pagination",
    '[class*="overlay"]', '[class*="modal"]',
    // Broader selectors for newer Etsy layouts
    '[data-component="reviews-modal"]', '[data-region="reviews-overlay"]',
    'div[class*="ReviewsModal"]', 'div[class*="reviews-modal"]',
    'section[aria-label*="review" i]',
    // Etsy 2025+: reviews open in a "sheet" drawer, not an overlay
    '.wt-sheet', '.deep-dive-sheet',
    'div[class*="deep-dive"]',
  ];

  // Quick check for modal
  for (const selector of modalSelectors) {
    const quickCheck = document.querySelector(selector);
    if (quickCheck && quickCheck.offsetParent !== null) {
      rdLog("[Review Dates] Modal found with selector:", selector);
      return true;
    }
  }

  // Wait for modal with timeouts
  for (const selector of modalSelectors) {
    const modal = await waitForElement(selector, 1500);
    if (modal) {
      rdLog("[Review Dates] Modal appeared with selector:", selector);
      return true;
    }
  }

  // Fallback: detect NEW dialog/sheet elements that appeared after click
  const postClickDialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"], .wt-overlay, [class*="overlay"], [class*="modal"], .wt-sheet, .deep-dive-sheet');
  for (const el of postClickDialogs) {
    if (!preClickDialogs.has(el) && el.offsetParent !== null) {
      const text = el.innerText || "";
      if (/[A-Z][a-z]{2} \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2},? \d{4}/.test(text) || /review/i.test(text)) {
        rdLog("[Review Dates] Modal detected via post-click DOM diff");
        return true;
      }
    }
  }

  // Last resort: check if review dates appeared in inline reviews section
  const reviewSection = document.getElementById("reviews") || document.querySelector('[data-selector="reviews-region"]');
  if (reviewSection) {
    const dateRegex = /[A-Z][a-z]{2} \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2},? \d{4}/;
    if (dateRegex.test(reviewSection.innerText || "")) {
      rdLog("[Review Dates] No modal, but reviews section has dates (inline reviews)");
      return true;
    }
  }

  rdLog("[Review Dates] Modal did not appear after click");
  return false;
}

// Helper: Get the reviews modal/overlay element (the actual popup, not main page)
function getReviewsModalArea() {
  // Strategy 0: Etsy 2025+ uses a "sheet" drawer for reviews, not an overlay
  const sheetSelectors = [
    ".deep-dive-sheet",
    ".wt-sheet",
    'div[class*="deep-dive"]',
  ];
  for (const selector of sheetSelectors) {
    try {
      const sheet = document.querySelector(selector);
      if (sheet && sheet.offsetParent !== null) {
        const text = sheet.innerText || "";
        if (/[A-Z][a-z]{2} \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2},? \d{4}/.test(text)) {
          rdLog("[Review Dates] Found reviews in wt-sheet/deep-dive-sheet");
          return sheet;
        }
      }
    } catch { /* continue */ }
  }

  // Strategy 1: Specific overlay selectors (legacy)
  const overlaySelectors = [
    ".wt-overlay__modal",
    '[role="dialog"][aria-modal="true"]',
    '[aria-modal="true"]',
    '.wt-overlay[aria-hidden="false"]',
    '.wt-overlay:not([aria-hidden="true"])',
    '[data-component="reviews-modal"]',
    'div[class*="ReviewsModal"]',
    'div[class*="reviews-modal"]',
  ];

  for (const selector of overlaySelectors) {
    try {
      const modal = document.querySelector(selector);
      if (modal && modal.offsetParent !== null) {
        const text = modal.innerText || "";
        if (/[A-Z][a-z]{2} \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2},? \d{4}/.test(text)) {
          return modal;
        }
      }
    } catch {
      // Selector might not be valid, continue
    }
  }

  // Strategy 2: Any visible overlay/dialog/modal with review dates
  const broadSelectors = '.wt-overlay, [role="dialog"], .wt-modal, [class*="overlay"], [class*="modal"], [aria-modal="true"]';
  const allOverlays = document.querySelectorAll(broadSelectors);
  for (const overlay of allOverlays) {
    if (overlay.offsetParent !== null) {
      const text = overlay.innerText || "";
      if (/[A-Z][a-z]{2} \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2},? \d{4}/.test(text) && !text.includes("Add to cart")) {
        return overlay;
      }
    }
  }

  // Strategy 3: Any visible dialog
  const dialog = document.querySelector('[role="dialog"]') || document.querySelector('[aria-modal="true"]');
  if (dialog && dialog.offsetParent !== null) {
    return dialog;
  }

  // Strategy 4: Look for the inline reviews section (some Etsy layouts don't use a modal)
  const reviewsSection = document.getElementById("reviews") ||
    document.getElementById("same-listing-reviews") ||
    document.querySelector('[data-selector="reviews-region"]');
  if (reviewsSection) {
    const text = reviewsSection.innerText || "";
    if (/[A-Z][a-z]{2} \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2},? \d{4}/.test(text)) {
      rdLog("[Review Dates] Using inline reviews section instead of modal");
      return reviewsSection;
    }
  }

  return null;
}

// Helper: Extract first visible review date (most recent - from page 1)
function extractFirstVisibleReviewDate() {
  const modal = getReviewsModalArea();
  const searchArea = modal || document;
  rdLog(
    "[Review Dates] extractFirstVisible: modal found:",
    !!modal,
    "searching in:",
    modal ? "modal" : "document",
  );

  // Look for date elements in reviews
  const dateSelectors = [
    ".review-date",
    ".wt-text-caption",
    "[data-review-date]",
    ".wt-text-gray",
    "time[datetime]",
    ".wt-text-body-01",
    "p.wt-text-caption",
  ];

  for (const selector of dateSelectors) {
    const elements = searchArea.querySelectorAll(selector);
    for (const dateEl of elements) {
      const text = dateEl.innerText?.trim() || dateEl.getAttribute("datetime") || "";
      const dateMatch = text.match(/[A-Z][a-z]{2} \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2},? \d{4}/);
      if (dateMatch) {
        rdLog(
          "[Review Dates] extractFirstVisible: found date via selector",
          selector,
          ":",
          dateMatch[0],
        );
        return dateMatch[0];
      }
    }
  }

  // Fallback: regex search in entire modal/page text
  const text = searchArea.innerText || "";
  const dateRegex = /[A-Z][a-z]{2} \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2},? \d{4}/g;
  const matches = text.match(dateRegex);
  rdLog(
    "[Review Dates] extractFirstVisible: fallback regex found",
    matches?.length || 0,
    "dates",
  );
  if (matches && matches.length > 0) {
    rdLog("[Review Dates] extractFirstVisible: returning", matches[0]);
    return matches[0];
  }

  rdLog("[Review Dates] extractFirstVisible: NO DATES FOUND");
  return null;
}

// Helper: Extract last visible review date (oldest on current page)
function extractLastVisibleReviewDate() {
  const modal = getReviewsModalArea();
  const searchArea = modal || document;
  const text = searchArea.innerText || "";

  const dateRegex = /[A-Z][a-z]{2} \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2},? \d{4}/g;
  const matches = text.match(dateRegex);
  if (matches && matches.length > 0) {
    // Sort dates to find actual oldest
    const parsedDates = matches
      .map((d) => ({ str: d, date: new Date(d) }))
      .filter((d) => !isNaN(d.date))
      .sort((a, b) => a.date - b.date);

    if (parsedDates.length > 0) {
      return parsedDates[0].str;
    }
  }

  return null;
}

// Helper: Find highest visible page number button
function findHighestPageButton(searchArea) {
  const allButtons = searchArea.querySelectorAll("button, a");
  let highestPageNum = 0;
  let highestPageBtn = null;

  for (const btn of allButtons) {
    const text = (btn.innerText || "").trim();

    // Check if it's a page number (just a number, not something like "123 reviews")
    if (/^\d+$/.test(text)) {
      const pageNum = parseInt(text, 10);
      if (pageNum > highestPageNum && pageNum < 1000) {
        highestPageNum = pageNum;
        highestPageBtn = btn;
      }
    }
  }

  return { btn: highestPageBtn, num: highestPageNum };
}

// Helper: Get snapshot of dates currently visible in modal (for change detection)
function getVisibleDatesSnapshot() {
  const modal = getReviewsModalArea();
  const searchArea = modal || document;
  const text = searchArea.innerText || "";
  const dateRegex = /[A-Z][a-z]{2} \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2},? \d{4}/g;
  const matches = text.match(dateRegex);
  return matches ? matches.join("|") : "";
}

function getPaginationSnapshot() {
  const modal = getReviewsModalArea();
  const searchArea = modal || document;
  const allButtons = searchArea.querySelectorAll("button, a");
  const parts = [];

  for (const btn of allButtons) {
    const text = (btn.innerText || "").trim();
    if (!/^\d+$/.test(text)) continue;
    const current =
      btn.getAttribute("aria-current") === "page" ||
      btn.getAttribute("aria-selected") === "true" ||
      btn.classList.contains("wt-btn--filled") ||
      btn.classList.contains("is-selected") ||
      btn.classList.contains("is-active");
    parts.push(`${text}:${current ? 1 : 0}`);
  }

  return parts.join("|");
}

// Helper: Wait for review modal pagination/content to advance after a click.
async function waitForReviewModalAdvance(previousSnapshot, previousPagination, timeout = 8000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const currentSnapshot = getVisibleDatesSnapshot();
    const currentPagination = getPaginationSnapshot();
    if (
      (currentSnapshot !== previousSnapshot && currentSnapshot.length > 0) ||
      (currentPagination !== previousPagination && currentPagination.length > 0)
    ) {
      return true;
    }
    await sleep(200);
  }
  return false;
}

// Human-like: gently scroll down through the current review page (a few smooth
// steps with pauses) so the modal doesn't blast through pages instantly like a bot.
async function scrollReviewsModalArea() {
  const area = getReviewsModalArea();
  if (!area) return;
  const steps = randomInRange(2, 3);
  for (let i = 0; i < steps; i++) {
    try {
      area.scrollBy({ top: randomInRange(250, 450), behavior: "smooth" });
    } catch {
      try {
        area.scrollTop = (area.scrollTop || 0) + randomInRange(250, 450);
      } catch {
        // element not scrollable — leave it
      }
    }
    await sleep(randomInRange(500, 900));
  }
}

// Helper: Navigate review pagination until the real end or our 20-page cap.
async function navigateToLastReviewPage() {
  const searchArea = getReviewsModalArea() || document;
  let previousHighestLegacy = 0;
  const maxIterationsLegacy = 20; // Safety limit
  let lastClickedPageLegacy = 0;
  let sawModalPage = false;

  for (let iteration = 0; iteration < maxIterationsLegacy; iteration++) {
    const { btn: highestBtn, num: highestNum } = findHighestPageButton(searchArea);

    if (!highestBtn) {
      if (iteration === 0) {
        const visibleOldest = extractLastVisibleReviewDate();
        if (visibleOldest) {
          rdLog("[Review Dates] Modal has no pagination controls; treating current page as final page");
          return { reachedEnd: true, hitCap: false };
        }
        return { reachedEnd: false, hitCap: false };
      }
      break;
    }
    sawModalPage = true;

    if (highestNum >= 20) {
      rdLog("[Review Dates] Reached page-20 cap, using LONG TIME AGO");
      return { reachedEnd: false, hitCap: true, pagesClicked: lastClickedPageLegacy };
    }

    if (highestNum <= previousHighestLegacy) break;

    const beforeSnapshot = getVisibleDatesSnapshot();
    const beforePagination = getPaginationSnapshot();
    // Read down through the current page before clicking to the next (human-like).
    await scrollReviewsModalArea();
    highestBtn.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(randomInRange(400, 800));
    highestBtn.click();
    const advanced = await waitForReviewModalAdvance(beforeSnapshot, beforePagination, 8000);
    if (!advanced) {
      rdLog("[Review Dates] Pagination did not advance after clicking page", highestNum);
      break;
    }

    previousHighestLegacy = highestNum;
    lastClickedPageLegacy = highestNum;
    // Slower, varied pause between pages so it doesn't speed through like a bot.
    await sleep(randomInRange(1200, 2400));
  }

  if (lastClickedPageLegacy > 0) {
    await sleep(randomInRange(1000, 1500));
    return { reachedEnd: true, hitCap: false, pagesClicked: lastClickedPageLegacy };
  }

  if (sawModalPage) {
    return { reachedEnd: true, hitCap: false, pagesClicked: 1 };
  }

  return { reachedEnd: false, hitCap: false, pagesClicked: 0 };
}

// Helper: Close the reviews modal
async function closeReviewsModal() {
  const closeSelectors = [
    '[role="dialog"] button[aria-label*="close" i]',
    '[role="dialog"] button[aria-label*="Close"]',
    '.wt-overlay button[aria-label*="close" i]',
    '.wt-modal button[aria-label*="close" i]',
    "[data-modal-close]",
    ".wt-modal__close",
    'button[aria-label="Close"]',
    ".wt-overlay__close",
  ];

  for (const selector of closeSelectors) {
    try {
      const closeBtn = document.querySelector(selector);
      if (closeBtn) {
        closeBtn.click();
        await sleep(200);
        return true;
      }
    } catch {
      // Continue trying other selectors
    }
  }

  // Try pressing Escape as fallback
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }),
  );
  await sleep(300);

  const modal = document.querySelector('[role="dialog"], .wt-overlay, .wt-modal');
  return !modal;
}

// Read Etsy's explicit listing_rating_count from the page data, or null if not present
// yet (UNKNOWN — e.g. the page hasn't finished loading). Never infer 0 from absence.
function readListingRatingCount() {
  for (const el of document.querySelectorAll("[data-appears-event-data]")) {
    try {
      const data = JSON.parse(el.getAttribute("data-appears-event-data"));
      if (data && data.listing_rating_count != null) {
        const n = parseInt(data.listing_rating_count, 10);
        if (!Number.isNaN(n)) return n;
      }
    } catch {
      // Malformed JSON — try the next element.
    }
  }
  return null;
}

// Mirror of core noItemReviews() (src/core/extract-listing.js) — kept in sync; content
// scripts can't import modules. Authoritative "this ITEM has zero reviews": Etsy reports
// listing_rating_count 0, OR the page shows "Be the first to review this item".
function hasNoItemReviews() {
  if (readListingRatingCount() === 0) return true;
  if (/be the first to review this item/i.test(document.body?.innerText || "")) return true;
  return false;
}

// Wait until the page has actually RENDERED its review area before judging whether the
// item has reviews — so a half-loaded page never falls through to the SHOP reviews modal
// (the bug: an item with no reviews opened the shop's reviews instead). Resolves as soon
// as any review signal is present (count data, the review header, the reviews region, or
// the empty-state copy), or after `timeout`.
async function waitForReviewSignal(timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (
      readListingRatingCount() !== null ||
      document.querySelector(".review-header-text, h2[class*='review-header']") ||
      document.getElementById("reviews") ||
      document.querySelector('[data-selector="reviews-region"]') ||
      /be the first to review this item/i.test(document.body?.innerText || "")
    ) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

// Main function: Extract accurate review dates via modal pagination
// forceModal: if true, always try to open modal even for few reviews (used by Force Review button)
async function extractReviewDates(forceModal = false) {
  const result = {
    success: false,
    firstReviewDate: null,
    lastReviewDate: null,
    totalReviews: 0,
    method: "static",
    audit: {
      modal_found: false,
      modal_selector: null,
      search_area: "document",
      pages_navigated: 0,
      raw_dates_page1: [],
      raw_dates_last_page: [],
      static_dates: null,
      button_text: null,
      extraction_errors: [],
      listing_id: window.location.href.match(/\/listing\/(\d+)/)?.[1] || null,
      page_url: window.location.href,
    },
  };

  try {
    // PREVENTION (golden rule): wait for the review area to actually render, then HARD-STOP
    // if the item authoritatively has NO reviews. A no-review item has no item-reviews
    // modal, so opening one — even with forceModal — scrapes the SHOP's reviews by mistake.
    // This runs BEFORE the forceModal branch precisely so forceModal can't override it.
    await waitForReviewSignal();
    if (hasNoItemReviews()) {
      rdLog("[Review Dates] Item has NO reviews (be-the-first / listing_rating_count=0) — returning None, NOT opening any modal");
      result.success = true;
      result.totalReviews = 0;
      result.firstReviewDate = "None";
      result.lastReviewDate = "None";
      result.method = "no_reviews";
      return result;
    }

    const reviewCount = getReviewCount();
    result.totalReviews = reviewCount;
    rdLog("[Review Dates] Review count detected:", reviewCount, "forceModal:", forceModal);

    if (reviewCount === 0 && !forceModal) {
      rdLog("[Review Dates] No reviews found, returning None");
      result.success = true;
      result.firstReviewDate = "None";
      result.lastReviewDate = "None";
      result.method = "no_reviews";
      return result;
    }

    // Always try to open reviews modal for pagination so first_review is true oldest.
    rdLog("[Review Dates] Attempting to open reviews modal...");
    const modalOpened = await openReviewsModal();
    rdLog("[Review Dates] Modal opened:", modalOpened);
    result.audit.modal_found = modalOpened;
    result.audit.button_text = window.__lastReviewButtonText || null;

      if (!modalOpened) {
        rdLog("[Review Dates] Modal failed to open, falling back to static extraction");
        const staticDates = extractStaticReviewDates();
        result.audit.static_dates = staticDates;
        result.success = true;
        if (shouldTrustStaticReviewDates(reviewCount, staticDates)) {
          result.firstReviewDate = staticDates.firstReviewDate;
          result.lastReviewDate = staticDates.lastReviewDate;
          result.method = "static-trusted";
        } else {
          // Static fallback only sees page 1 reviews — lastReviewDate (newest) is reliable
          // but firstReviewDate (oldest) is NOT — it's just the oldest visible, not the actual first.
          // Return null for firstReviewDate so we don't overwrite the real value in the DB.
          result.firstReviewDate = null;
          result.lastReviewDate = staticDates.lastReviewDate || "N/A";
          result.method = "static-fallback";
        }
        return result;
      }

    // Wait for reviews content to load in the sheet/modal (dates take a moment to render)
    let modalArea = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      modalArea = getReviewsModalArea();
      if (modalArea) break;
      rdLog(`[Review Dates] Waiting for sheet content to load... attempt ${attempt + 1}`);
      await sleep(500);
    }
    result.audit.search_area = modalArea ? "modal" : "document";
    if (modalArea) {
      // Log which selector matched the modal
      const overlaySelectors = [
        ".wt-overlay__modal",
        '[role="dialog"][aria-modal="true"]',
        '.wt-overlay[aria-hidden="false"]',
        '.wt-overlay:not([aria-hidden="true"])',
      ];
      for (const sel of overlaySelectors) {
        try {
          if (document.querySelector(sel)?.contains(modalArea) || document.querySelector(sel) === modalArea) {
            result.audit.modal_selector = sel;
            break;
          }
        } catch { /* skip */ }
      }
    }

    // Capture raw dates visible on page 1 of modal
    const page1SearchArea = modalArea || document;
    const page1Text = page1SearchArea.innerText || "";
    const page1DateMatches = page1Text.match(/[A-Z][a-z]{2} \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2},? \d{4}/g) || [];
    result.audit.raw_dates_page1 = page1DateMatches.slice(0, 20); // cap at 20 for log size

    // Extract most recent review date (page 1)
    await sleep(randomInRange(800, 1200));
    result.lastReviewDate = extractFirstVisibleReviewDate();
    rdLog("[Review Dates] After extractFirstVisibleReviewDate:", result.lastReviewDate);

    // Navigate to last page for oldest review
    const navigationResult = await navigateToLastReviewPage();
    rdLog("[Review Dates] Navigated to last page:", navigationResult);
    result.audit.pages_navigated = navigationResult.pagesClicked || 0;

    if (navigationResult.hitCap) {
      result.firstReviewDate = "LONG TIME AGO";
      result.method = "capped_20_pages";
    } else if (navigationResult.reachedEnd) {
      await sleep(randomInRange(1500, 2000));

      // Capture raw dates visible on last page
      const lastPageArea = getReviewsModalArea() || document;
      const lastPageText = lastPageArea.innerText || "";
      const lastPageDateMatches = lastPageText.match(/[A-Z][a-z]{2} \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2},? \d{4}/g) || [];
      result.audit.raw_dates_last_page = lastPageDateMatches.slice(0, 20);

      result.firstReviewDate = extractLastVisibleReviewDate();
      result.method = "paginated";
    } else {
      result.firstReviewDate = null;
      result.method = "modal-partial";
      result.audit.extraction_errors.push("navigation_incomplete");
    }
    // Set success BEFORE closing modal so it's set even if close fails
    result.success = true;
    rdLog("[Review Dates] Final result:", JSON.stringify(result));

    await closeReviewsModal();
    return result;
  } catch (err) {
    console.error("[Review Dates] Error during extraction:", err);
    result.audit.extraction_errors.push(err.message || String(err));

    // Attempt to close modal if open
    try {
      await closeReviewsModal();
    } catch {
      // Ignore close errors
    }

      // Return fallback static dates — only lastReviewDate is reliable from page 1
      const staticDates = extractStaticReviewDates();
      result.audit.static_dates = staticDates;
      if (shouldTrustStaticReviewDates(result.totalReviews, staticDates)) {
        result.firstReviewDate = staticDates.firstReviewDate;
        result.lastReviewDate = staticDates.lastReviewDate;
        result.method = "static-trusted";
      } else {
        result.firstReviewDate = null;
        result.lastReviewDate = staticDates.lastReviewDate || "N/A";
        result.method = "error-static-fallback";
      }
      result.success = true;
      return result;
    }
  }
})();
