// Shared classic-script review-date helpers for passive.js. Chrome content
// scripts are not ES modules, so this file exposes one frozen local namespace
// and is injected immediately before passive.js by manifest.json.
(() => {
  const MONTH_INDEX = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
    january: 0, february: 1, march: 2, april: 3, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };

  function inEtsyDateRange(date) {
    if (!date || Number.isNaN(date.getTime())) return null;
    const year = date.getUTCFullYear();
    return year >= 2005 && year <= new Date().getUTCFullYear() + 1 ? date : null;
  }

  function parseValidReviewDate(value) {
    const text = String(value || "").trim();
    if (!text) return null;

    const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
      const year = Number(iso[1]);
      const month = Number(iso[2]);
      const day = Number(iso[3]);
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
      return inEtsyDateRange(date);
    }

    let month;
    let day;
    let year;
    let match = text.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
    if (match) {
      month = MONTH_INDEX[match[1].toLowerCase()];
      day = Number(match[2]);
      year = Number(match[3]);
    } else {
      match = text.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
      if (match) {
        month = MONTH_INDEX[match[2].toLowerCase()];
        day = Number(match[1]);
        year = Number(match[3]);
      }
    }
    if (month === undefined || !day || !year) return null;
    const date = new Date(Date.UTC(year, month, day));
    if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
    return inEtsyDateRange(date);
  }

  function extractReviewDatesFromArea(area) {
    if (!area) return [];
    const values = [];
    for (const element of area.querySelectorAll?.("time[datetime], [data-review-date]") || []) {
      values.push(element.getAttribute("datetime") || element.getAttribute("data-review-date") || "");
    }
    const text = area.innerText || area.textContent || "";
    values.push(
      ...(text.match(/[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}|\d{4}-\d{2}-\d{2}/g) || []),
    );

    const dates = new Set();
    for (const value of values) {
      const date = parseValidReviewDate(value);
      if (date) dates.add(date.toISOString().slice(0, 10));
    }
    return [...dates].sort();
  }

  function hasReviewDate(area) {
    return extractReviewDatesFromArea(area).length > 0;
  }

  globalThis.iScaleReviewDateUtils = Object.freeze({
    extractReviewDatesFromArea,
    hasReviewDate,
    parseValidReviewDate,
  });
})();
