(function () {
  "use strict";

  if (window.__etsyResearchSearchRan) return;
  window.__etsyResearchSearchRan = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Message the service worker, tolerating an invalidated extension context (this content
  // script outlives an extension reload; chrome.runtime.sendMessage then throws
  // synchronously). Fails silently instead of an uncaught "Extension context invalidated".
  function safeSend(message) {
    try {
      if (!chrome.runtime?.id) return Promise.resolve(null); // orphaned — extension was reloaded
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  // Physically scroll the search page like a human — a proven pacing profile
  // (variable steps, occasional pauses + small scroll-ups, stops near the
  // footer/pagination). Also forces Etsy's lazy-loaded listings to render
  // before we extract, and looks natural while the batch runs.
  async function simulateHumanScrolling() {
    await sleep(Math.floor(Math.random() * 400) + 300);
    let totalHeight = document.body.scrollHeight;

    const footer = document.querySelector("footer, #footer, .wt-footer");
    const pagination = document.querySelector(".wt-action-group--justified, .search-pagination, nav[aria-label*='pagination']");
    const lastRow = document.querySelector(".search-listings-group > div:last-child, .wt-grid__item-xs-6:last-of-type");

    let stopAt = totalHeight;
    if (footer) stopAt = Math.min(stopAt, footer.offsetTop - 100);
    if (pagination) stopAt = Math.min(stopAt, pagination.offsetTop + 200);
    if (lastRow) stopAt = Math.min(stopAt, lastRow.offsetTop + lastRow.offsetHeight);

    const minPercent = 0.7 + Math.random() * 0.15;
    stopAt = Math.max(stopAt, totalHeight * minPercent);

    if (totalHeight < window.innerHeight + 200) {
      await sleep(1000);
      totalHeight = document.body.scrollHeight;
    }

    let lastY = -1;
    let stuckCount = 0;
    let iterations = 0;
    let consecutive = 0;
    const pauseEvery = Math.floor(Math.random() * 4) + 3;

    while (iterations < 100) {
      iterations++;
      consecutive++;
      const current = window.scrollY;
      if (current + window.innerHeight >= stopAt && stuckCount > 1) break;

      const r = Math.random();
      if (r < 0.05 && current > 300) {
        window.scrollBy({ top: -(Math.floor(Math.random() * 100) + 50), behavior: "smooth" });
        await sleep(Math.floor(Math.random() * 300) + 200);
      } else if (r < 0.25) {
        window.scrollBy({ top: Math.floor(Math.random() * 150) + 150, behavior: "smooth" });
      } else if (r < 0.85) {
        window.scrollBy({ top: Math.floor(Math.random() * 200) + 300, behavior: "smooth" });
      } else {
        window.scrollBy({ top: Math.floor(Math.random() * 300) + 500, behavior: "auto" });
      }

      if (consecutive >= pauseEvery) {
        await sleep(Math.floor(Math.random() * 400) + 300);
        consecutive = 0;
      } else {
        await sleep(Math.floor(Math.random() * 170) + 80);
      }

      if (window.scrollY === lastY) {
        stuckCount++;
        if (stuckCount > 5) break;
      } else {
        stuckCount = 0;
      }
      lastY = window.scrollY;

      const newHeight = document.body.scrollHeight;
      if (newHeight > totalHeight) {
        totalHeight = newHeight;
        stopAt = Math.max(stopAt, newHeight * minPercent);
        stuckCount = 0;
      }
    }
    await sleep(Math.floor(Math.random() * 200) + 100);
  }

  function normalizeListingUrl(value) {
    try {
      const parsed = new URL(value, window.location.origin);
      if (!/(^|\.)etsy\.com$/i.test(parsed.hostname)) return null;
      const match = parsed.pathname.match(/\/listing\/(\d{7,12})(?:\/|$)/);
      if (!match) return null;
      const parts = parsed.pathname.split("/").filter(Boolean);
      const slug = parts[2] ? `/${parts[2]}` : "";
      return `https://www.etsy.com/listing/${match[1]}${slug}`;
    } catch {
      return null;
    }
  }

  function extractSearchLinks() {
    const seen = new Set();
    for (const anchor of document.querySelectorAll("a[href*='/listing/']")) {
      const normalized = normalizeListingUrl(anchor.href);
      if (normalized) seen.add(normalized);
    }
    return Array.from(seen);
  }

  // ---- full search-result capture (mirror of src/core/search-results.js) ----

  function num(value) {
    if (value == null || value === "") return null;
    const match = String(value).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    return match ? Number.parseFloat(match[0]) : null;
  }

  function closestCard(anchor) {
    let el = anchor;
    for (let i = 0; i < 6 && el && el.parentElement; i++) {
      el = el.parentElement;
      if (!el.getAttribute) continue;
      if (el.getAttribute("data-listing-id") || /(^|\s)(v2-listing-card|listing-link|wt-grid__item|js-merch-stash-check-listing)/.test(el.className || "")) return el;
      if (el.tagName === "LI") return el;
    }
    return anchor.parentElement || anchor;
  }

  function cardText(card, selector) {
    const el = card && card.querySelector ? card.querySelector(selector) : null;
    return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  }

  function cardPrice(card) {
    if (!card || !card.querySelector) return "";
    const value = card.querySelector(".currency-value");
    if (value) {
      const symbol = card.querySelector(".currency-symbol");
      return `${symbol ? symbol.textContent.trim() : ""}${value.textContent.trim()}`;
    }
    const match = (card.textContent || "").match(/[$£€]\s?\d[\d,.]*/);
    return match ? match[0].replace(/\s/g, "") : "";
  }

  function cardRating(card) {
    if (!card || !card.querySelector) return null;
    for (const el of card.querySelectorAll('[aria-label*="out of 5"], input[name*="rating"]')) {
      const label = String(el.getAttribute("aria-label") || el.getAttribute("value") || "");
      const m = label.match(/([\d.]+)\s*out of 5/i) || String(el.getAttribute("value") || "").match(/^([\d.]+)$/);
      if (m) return Number.parseFloat(m[1]);
    }
    return null;
  }

  function cardReviewCount(card) {
    if (!card || !card.querySelector) return null;
    const labelled = card.querySelector('[aria-label*="review" i]');
    if (labelled) {
      const n = num(labelled.getAttribute("aria-label"));
      if (n != null) return n;
    }
    const m = (card.textContent || "").match(/\(([\d,]+)\)/);
    return m ? num(m[1]) : null;
  }

  function cardImage(card) {
    const img = card && card.querySelector ? card.querySelector("img") : null;
    return img ? img.getAttribute("src") || img.getAttribute("data-src") || "" : "";
  }

  function cardIsAd(card) {
    const text = ((card && card.textContent) || "").toLowerCase();
    return text.includes("ad by") || text.includes("advertisement") || text.includes("ad from");
  }

  function parseSearchResults() {
    const url = new URL(window.location.href);
    const keyword = (url.searchParams.get("q") || "").trim();
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const capturedAt = new Date().toISOString();
    const results = [];
    const seen = new Set();

    for (const anchor of document.querySelectorAll('a[href*="/listing/"]')) {
      const listingId = (String(anchor.getAttribute("href") || "").match(/\/listing\/(\d{7,12})/) || [])[1];
      if (!listingId || seen.has(listingId)) continue;
      seen.add(listingId);
      const card = closestCard(anchor);
      results.push({
        keyword,
        page,
        position: results.length + 1,
        listingId,
        url: `https://www.etsy.com/listing/${listingId}`,
        title: cardText(card, "h3") || (anchor.getAttribute("title") || anchor.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
        price: cardPrice(card),
        reviewCount: cardReviewCount(card),
        rating: cardRating(card),
        shopName: cardText(card, ".v2-listing-card__shop, [data-shop-name]"),
        imageUrl: cardImage(card),
        isAd: cardIsAd(card),
        capturedAt,
      });
    }
    return { keyword, page, capturedAt, results };
  }

  // Auto-capture full search results shortly after the page settles. Captured in
  // a variable so a runner-driven scrape can cancel it (see scrollAndExtract):
  // otherwise the runner's own capture AND this passive one both fire for the
  // same page, double-logging it and double-counting its appearance history.
  const autoCaptureTimer = setTimeout(() => {
    const payload = parseSearchResults();
    if (!payload.keyword || payload.results.length === 0) return;
    // fromManualBrowse → the background also accumulates these cards as listings
    // tagged with this keyword, so manual browsing feeds the same collection as
    // a scrape. The runner path skips this (it visits each listing for full data).
    safeSend({ action: "search.saveResults", input: { payload, fromManualBrowse: true } });
  }, 1800);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ error: "unauthorized" });
      return true;
    }
    if (message?.action === "search.scrollAndExtract") {
      // The runner is driving this page — cancel the passive auto-capture so we
      // don't capture the same page twice.
      clearTimeout(autoCaptureTimer);
      // Scroll the page like a human, then extract everything that loaded.
      simulateHumanScrolling()
        .then(() => sendResponse({ urls: extractSearchLinks(), payload: parseSearchResults() }))
        .catch(() => sendResponse({ urls: extractSearchLinks(), payload: parseSearchResults() }));
      return true;
    }
    sendResponse({ error: "unknown_action" });
    return true;
  });
})();
