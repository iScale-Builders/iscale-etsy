// Drive an Etsy search the way a person would: focus the search box, type the
// term one character at a time, and press the search button. Callers fall back
// to the search URL only when this returns path "url_navigation".

export const SEARCH_BOX_SELECTORS = [
  "#global-enhancements-search-query",
  'input[name="search_query"]',
  'form[action*="/search"] input[type="search"]',
  'form[action*="/search"] input[type="text"]',
  'input[type="search"][aria-label*="search" i]',
];

export function findSearchBox(doc) {
  if (!doc?.querySelector) return null;
  for (const selector of SEARCH_BOX_SELECTORS) {
    const el = doc.querySelector(selector);
    if (!el || el.disabled || el.getAttribute?.("type") === "hidden") continue;
    return el;
  }
  return null;
}

export function findSearchSubmit(box) {
  const form = box?.form || box?.closest?.("form") || null;
  if (!form?.querySelector) return { form: null, button: null };
  const button =
    form.querySelector('button[type="submit"]') ||
    form.querySelector('button[aria-label*="Search" i]') ||
    form.querySelector('input[type="submit"]') ||
    form.querySelector("button");
  return { form, button: button || null };
}

export function keystrokeDelayMs(rand = Math.random, min = 40, max = 140) {
  const lo = Math.max(0, Number(min) || 0);
  const hi = Math.max(lo, Number(max) || lo);
  if (rand() < 0.08) return hi + Math.floor(rand() * 180);
  return lo + Math.floor(rand() * (hi - lo + 1));
}

function setInputValue(el, value) {
  const proto = typeof HTMLInputElement === "function"
    ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
    : null;
  if (proto?.set) proto.set.call(el, value);
  else el.value = value;
}

function dispatchInput(el, data) {
  let event;
  try {
    event = new InputEvent("input", { bubbles: true, data, inputType: "insertText" });
  } catch {
    event = new Event("input", { bubbles: true });
  }
  el.dispatchEvent(event);
}

export function formatSearchPathLog(entry) {
  const path = entry?.path || "unknown";
  const detail = entry?.reason || entry?.method || "";
  return `[etsy-worker] search path: ${path}${detail ? ` (${detail})` : ""}`;
}

export function isEtsySearchForTerm(url, term) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)etsy\.com$/i.test(parsed.hostname)) return false;
    if (!parsed.pathname.startsWith("/search")) return false;
    const q = (parsed.searchParams.get("q") || parsed.searchParams.get("search_query") || "")
      .replace(/\+/g, " ")
      .trim()
      .toLowerCase();
    return q === String(term || "").trim().toLowerCase();
  } catch {
    return false;
  }
}

// `submit: false` types the term and reports the path without activating the
// button, so a content script can answer the extension before the page unloads.
export async function typeAndSubmitSearch(doc, term, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const rand = deps.rand || Math.random;
  const text = String(term || "");
  const box = findSearchBox(doc);
  if (!box || !text.trim()) {
    return {
      ok: false,
      path: "url_navigation",
      reason: box ? "empty_term" : "search_box_not_found",
    };
  }

  box.scrollIntoView?.({ block: "center" });
  box.focus?.();
  setInputValue(box, "");
  dispatchInput(box, "");
  for (const ch of text) {
    await sleep(keystrokeDelayMs(rand, deps.keystrokeMinMs ?? 40, deps.keystrokeMaxMs ?? 140));
    const next = `${box.value || ""}${ch}`;
    setInputValue(box, next);
    box.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
    dispatchInput(box, ch);
    box.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
  }

  const controls = findSearchSubmit(box);
  if (deps.submit === false) {
    return { ok: true, path: "search_box", method: controls.button ? "button" : "submit", typed: true };
  }
  return activateSearchSubmit(doc, controls);
}

export function activateSearchSubmit(doc, controls = null) {
  const resolved = controls || findSearchSubmit(findSearchBox(doc));
  const { form, button } = resolved || {};
  if (button && !button.disabled) {
    button.click();
    return { ok: true, path: "search_box", method: "button" };
  }
  if (form) {
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return { ok: true, path: "search_box", method: "submit" };
  }
  const box = findSearchBox(doc);
  if (!box) return { ok: false, path: "url_navigation", reason: "search_box_not_found" };
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  return { ok: true, path: "search_box", method: "enter" };
}

function absoluteEtsyHref(anchor) {
  try {
    return new URL(anchor.getAttribute("href") || anchor.href, "https://www.etsy.com").toString();
  } catch {
    return null;
  }
}

export function planNextPage(doc, currentPage) {
  const next = Math.max(1, Number(currentPage) || 1) + 1;
  const anchors = [...(doc?.querySelectorAll?.("a[href]") || [])];
  const labelled = anchors.find((anchor) => /next/i.test(anchor.getAttribute("aria-label") || anchor.textContent || ""));
  const labelledHref = labelled ? absoluteEtsyHref(labelled) : null;
  if (labelledHref && /\/search/i.test(labelledHref)) {
    return { ok: true, path: "pagination_click", href: labelledHref };
  }
  for (const anchor of anchors) {
    const href = absoluteEtsyHref(anchor);
    if (!href) continue;
    try {
      const url = new URL(href);
      if (!url.pathname.startsWith("/search")) continue;
      if (Number(url.searchParams.get("page")) === next) {
        return { ok: true, path: "pagination_click", href: url.toString() };
      }
    } catch {
      // ignore malformed hrefs
    }
  }
  return { ok: false, path: "url_navigation", reason: "next_page_not_found" };
}

export function clickPlannedNext(doc, plan) {
  if (!plan?.href) return { ok: false, path: "url_navigation", reason: "next_page_not_found" };
  const anchors = [...(doc?.querySelectorAll?.("a[href]") || [])];
  const match = anchors.find((anchor) => absoluteEtsyHref(anchor) === plan.href);
  if (!match) return { ok: false, path: "url_navigation", reason: "next_page_not_found" };
  match.click();
  return { ok: true, path: "pagination_click", href: plan.href };
}
