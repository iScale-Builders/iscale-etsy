import { describe, expect, it, vi } from "vitest";
import {
  activateSearchSubmit,
  clickPlannedNext,
  findSearchBox,
  formatSearchPathLog,
  isEtsySearchForTerm,
  keystrokeDelayMs,
  planNextPage,
  typeAndSubmitSearch,
} from "../src/core/search-box.js";

function mount(html) {
  document.body.innerHTML = html;
  return document;
}

const instant = {
  sleep: async () => {},
  rand: () => 0.5,
  keystrokeMinMs: 40,
  keystrokeMaxMs: 40,
};

describe("typeAndSubmitSearch", () => {
  it("focuses the Etsy search box, types the term, and clicks Search", async () => {
    const doc = mount(`
      <form action="/search" method="get">
        <input id="global-enhancements-search-query" name="search_query" type="text" value="old" />
        <button type="submit" aria-label="Search">Search</button>
      </form>
    `);
    const box = findSearchBox(doc);
    const events = [];
    box.addEventListener("input", (event) => events.push(event.data));
    const button = doc.querySelector("button");
    const clicked = vi.fn();
    button.addEventListener("click", clicked);

    const result = await typeAndSubmitSearch(doc, "linen apron", instant);

    expect(result).toMatchObject({ ok: true, path: "search_box", method: "button" });
    expect(box.value).toBe("linen apron");
    expect(events.filter(Boolean)).toEqual(["l", "i", "n", "e", "n", " ", "a", "p", "r", "o", "n"]);
    expect(clicked).toHaveBeenCalledOnce();
    expect(formatSearchPathLog(result)).toBe("[etsy-worker] search path: search_box (button)");
  });

  it("falls back to url navigation when the search box is missing", async () => {
    const doc = mount("<main><p>No search</p></main>");
    const result = await typeAndSubmitSearch(doc, "linen apron", instant);
    expect(result).toEqual({ ok: false, path: "url_navigation", reason: "search_box_not_found" });
    expect(formatSearchPathLog(result)).toContain("url_navigation");
    expect(formatSearchPathLog(result)).toContain("search_box_not_found");
  });

  it("can type without submitting so the page script can answer first", async () => {
    const doc = mount(`
      <form action="/search">
        <input name="search_query" type="search" />
        <button type="submit">Search</button>
      </form>
    `);
    const clicked = vi.fn();
    doc.querySelector("button").addEventListener("click", clicked);
    const typed = await typeAndSubmitSearch(doc, "wool", { ...instant, submit: false });
    expect(typed).toMatchObject({ ok: true, path: "search_box", typed: true });
    expect(clicked).not.toHaveBeenCalled();
    const submitted = activateSearchSubmit(doc);
    expect(submitted.method).toBe("button");
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("submits the form when there is no search button", async () => {
    const doc = mount(`
      <form action="/search" method="get">
        <input name="search_query" type="text" />
      </form>
    `);
    const submitted = vi.fn();
    doc.querySelector("form").addEventListener("submit", submitted);
    const result = await typeAndSubmitSearch(doc, "mug", instant);
    expect(result).toMatchObject({ ok: true, path: "search_box", method: "submit" });
    expect(doc.querySelector("input").value).toBe("mug");
    expect(submitted).toHaveBeenCalled();
  });
});

describe("pagination", () => {
  it("plans a click on the next-page link", () => {
    const doc = mount(`
      <nav aria-label="Pagination">
        <a href="https://www.etsy.com/search?q=linen+apron&page=2" aria-label="Next page">Next</a>
      </nav>
    `);
    const plan = planNextPage(doc, 1);
    expect(plan.path).toBe("pagination_click");
    expect(plan.href).toContain("page=2");
    const clicked = vi.fn();
    doc.querySelector("a").addEventListener("click", clicked);
    expect(clickPlannedNext(doc, plan).path).toBe("pagination_click");
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("asks for url navigation when no next link exists", () => {
    const doc = mount("<main></main>");
    expect(planNextPage(doc, 1)).toEqual({ ok: false, path: "url_navigation", reason: "next_page_not_found" });
  });
});

describe("search url matching", () => {
  it("accepts q or search_query on etsy.com", () => {
    expect(isEtsySearchForTerm("https://www.etsy.com/search?q=linen+apron&page=1", "linen apron")).toBe(true);
    expect(isEtsySearchForTerm("https://www.etsy.com/search?search_query=linen%20apron", "Linen Apron")).toBe(true);
    expect(isEtsySearchForTerm("https://www.etsy.com/search?q=other", "linen apron")).toBe(false);
    expect(isEtsySearchForTerm("https://example.com/search?q=linen+apron", "linen apron")).toBe(false);
  });

  it("paces keystrokes inside the configured range", () => {
    expect(keystrokeDelayMs(() => 0.5, 40, 140)).toBeGreaterThanOrEqual(40);
    expect(keystrokeDelayMs(() => 0.5, 40, 140)).toBeLessThanOrEqual(140);
  });
});
