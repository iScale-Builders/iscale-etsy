import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";

// passive.js hand-mirrors several extractors from src/core/extract-listing.js
// (content scripts can't import ES modules). The demand patterns are already
// parity-guarded; these are the remaining mirrors that could drift silently:
// parsePrice, parseCurrency, detectDigitalVsPhysical, extractFavorites,
// extractReviewCount.
//
// Guard = normalized SOURCE equality: extract each function body from both
// files, normalize the two intentional differences (core takes a `doc`
// parameter where the content script uses the global `document`; core uses
// a defensive `getAttribute?.(`), collapse whitespace, and require the rest
// to match byte-for-byte. Any one-sided edit fails this test until the twin
// is updated too.

const here = dirname(fileURLToPath(import.meta.url));
const passiveSrc = readFileSync(join(here, "..", "passive.js"), "utf8");
const coreSrc = readFileSync(join(here, "..", "src", "core", "extract-listing.js"), "utf8");

// Slice a `function name(...) { ... }` out of a source string by balancing
// braces from the declaration onward. Good enough for these top-level,
// template-literal-free functions.
function extractFunction(src, name) {
  const decl = new RegExp(`function ${name}\\s*\\(`);
  const m = decl.exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  const start = m.index;
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name}: unbalanced braces`);
}

function normalize(fnSrc) {
  return (
    fnSrc
      // body only — the signature legitimately differs (doc param vs global)
      .slice(fnSrc.indexOf("{"))
      .replace(/\bdocument\b/g, "doc")
      .replace(/getAttribute\?\.\(/g, "getAttribute(")
      // comments may legitimately differ between the copies
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

const MIRRORED = [
  "parsePrice",
  "parseCurrency",
  "detectDigitalVsPhysical",
  "extractFavorites",
  "extractReviewCount",
];

describe("passive.js extractor parity with src/core/extract-listing.js", () => {
  for (const name of MIRRORED) {
    it(`${name} matches the canonical module`, () => {
      const core = normalize(extractFunction(coreSrc, name));
      const copy = normalize(extractFunction(passiveSrc, name));
      expect(copy, `${name} drifted from src/core/extract-listing.js`).toBe(core);
    });
  }
});

describe("mirrored pure parsers behave identically (functional check)", () => {
  // parsePrice/parseCurrency are pure — run both extracted copies on the
  // same fixtures so even a semantically-equivalent-looking rewrite that
  // changes behavior gets caught.
  const build = (src, name) =>
    new Function(`${extractFunction(src, name)}; return ${name};`)();

  const fixtures = ["$19.99", "1,299", "12,34", "€ 1.299,00", "USD 45", "free", "", null, undefined, "£3,450.10"];

  it("parsePrice agrees on all fixtures", () => {
    const a = build(coreSrc, "parsePrice");
    const b = build(passiveSrc, "parsePrice");
    for (const f of fixtures) {
      expect(b(f), `parsePrice(${JSON.stringify(f)})`).toStrictEqual(a(f));
    }
  });

  it("parseCurrency agrees on all fixtures", () => {
    const a = build(coreSrc, "parseCurrency");
    const b = build(passiveSrc, "parseCurrency");
    for (const f of fixtures) {
      expect(b(f), `parseCurrency(${JSON.stringify(f)})`).toStrictEqual(a(f));
    }
  });
});
