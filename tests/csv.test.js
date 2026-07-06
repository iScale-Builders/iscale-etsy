import { describe, expect, it } from "vitest";
import { csvHeaderLine, csvRowLine, csvToRows, escapeCsvCell, makeExportFilename, rowsToCsv, sanitizeFilename, sanitizeSubfolder, splitCsvList, unescapeCsvCell, withSubfolder } from "../src/core/csv.js";

describe("sanitizeFilename (download base name can't traverse or carry illegal chars)", () => {
  it("keeps normal dashed/dotted export names intact", () => {
    expect(sanitizeFilename("etsy-auto-export-2026-06-27T19-20-59.csv")).toBe("etsy-auto-export-2026-06-27T19-20-59.csv");
  });
  it("strips directory portions and traversal", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("/abs/path/x.csv")).toBe("x.csv");
    expect(sanitizeFilename("a\\b\\c.csv")).toBe("c.csv");
  });
  it("drops leading dots and illegal chars, falls back to 'download'", () => {
    expect(sanitizeFilename(".bashrc")).toBe("bashrc");
    expect(sanitizeFilename('a<b>c:"|?*.csv')).toBe("abc.csv");
    expect(sanitizeFilename("..")).toBe("download");
    expect(sanitizeFilename("")).toBe("download");
  });
  it("withSubfolder sanitizes the base name too", () => {
    expect(withSubfolder("../../evil.csv", "My Research")).toBe("My Research/evil.csv");
  });
});

describe("csv", () => {
  it("escapes cells with quotes and commas", () => {
    expect(escapeCsvCell('A "nice", mug')).toBe('"A ""nice"", mug"');
  });

  it("neutralizes spreadsheet formula injection (=,+,-,@ leads)", () => {
    expect(escapeCsvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(escapeCsvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(escapeCsvCell("+1-800")).toBe("'+1-800");
    // LOW-27: a formula hidden behind leading whitespace is still neutralized…
    expect(escapeCsvCell(" =1+1").startsWith("'")).toBe(true);
    expect(escapeCsvCell("\t@cmd").startsWith("'")).toBe(true);
    // …but a genuine leading space on normal text is left untouched.
    expect(escapeCsvCell(" hello world")).toBe(" hello world");
    // quoted+guarded when it also contains a comma
    expect(escapeCsvCell("=a,b")).toBe('"\'=a,b"');
    // normal values untouched
    expect(escapeCsvCell("$12.99")).toBe("$12.99");
    expect(escapeCsvCell("Cat Mug")).toBe("Cat Mug");
  });

  it("joins a flat primitive array (searchTerms) with '; ' and round-trips via splitCsvList", () => {
    expect(escapeCsvCell(["trending tshirt", "summer tee"])).toBe("trending tshirt; summer tee");
    expect(splitCsvList("trending tshirt; summer tee")).toEqual(["trending tshirt", "summer tee"]);
    expect(splitCsvList('["a","b"]')).toEqual(["a", "b"]); // tolerates legacy JSON
    expect(splitCsvList("")).toEqual([]);
    expect(splitCsvList(["a", "", "b"])).toEqual(["a", "b"]); // passthrough + cleans blanks
  });

  it("keeps an array of objects (demandHistory) as JSON", () => {
    expect(escapeCsvCell([{ value: 1 }])).toBe('"[{""value"":1}]"');
  });

  it("sanitizes a download subfolder (keeps spaces/dashes, blocks traversal)", () => {
    expect(sanitizeSubfolder("Etsy Research")).toBe("Etsy Research");
    expect(sanitizeSubfolder("my-folder")).toBe("my-folder");
    expect(sanitizeSubfolder("  spaced  ")).toBe("spaced");
    expect(sanitizeSubfolder("../../etc")).toBe("etc"); // traversal dropped
    expect(sanitizeSubfolder("/abs/path")).toBe("abs/path"); // leading slash stripped
    expect(sanitizeSubfolder('a<b>:c"d|e?f*g')).toBe("abcdefg"); // illegal chars removed
    expect(sanitizeSubfolder("")).toBe("");
    expect(sanitizeSubfolder("   ")).toBe("");
  });

  it("prefixes a filename with the sanitized subfolder", () => {
    expect(withSubfolder("etsy-2026.csv", "My Research")).toBe("My Research/etsy-2026.csv");
    expect(withSubfolder("etsy-2026.csv", "")).toBe("etsy-2026.csv");
    expect(withSubfolder("etsy-2026.csv", "../evil")).toBe("evil/etsy-2026.csv");
  });

  it("exports selected columns", () => {
    const csv = rowsToCsv([{ title: "Cat Mug", price: "$12.99" }], ["title", "price"]);
    expect(csv).toBe("title,price\nCat Mug,$12.99");
  });

  it("parses exported rows back from csv", () => {
    const rows = csvToRows('title,price,url\n"Cat ""Nice"" Mug","$12,99",https://www.etsy.com/listing/1234567890/cat-mug');
    expect(rows).toEqual([
      {
        title: 'Cat "Nice" Mug',
        price: "$12,99",
        url: "https://www.etsy.com/listing/1234567890/cat-mug",
      },
    ]);
  });

  it("strips the formula guard on import (round-trips the value)", () => {
    // The exact corruption the audit found: "+10 in carts" exported as
    // "'+10 in carts" was re-imported with the apostrophe still attached.
    for (const value of ["+10 in carts", "=HYPERLINK(1)", "@home", "-5 left"]) {
      const exported = escapeCsvCell(value);
      expect(unescapeCsvCell(exported.replace(/^"|"$/g, "").replace(/""/g, '"'))).toBe(value);
    }
  });

  it("end-to-end: a guarded cell survives rowsToCsv -> csvToRows", () => {
    const csv = rowsToCsv([{ demandText: "+10 in carts", title: "=SUM bug" }], ["demandText", "title"]);
    expect(csvToRows(csv)).toEqual([{ demandText: "+10 in carts", title: "=SUM bug" }]);
  });

  it("does not strip a legitimate leading apostrophe", () => {
    expect(unescapeCsvCell("'tis the season")).toBe("'tis the season");
    expect(unescapeCsvCell("'")).toBe("'");
  });

  it("creates stable csv filenames", () => {
    expect(makeExportFilename("etsy", new Date("2026-06-15T12:34:56Z"))).toBe("etsy-2026-06-15T12-34-56.csv");
  });

  it("M-6: drops dangerous header keys (no prototype pollution)", () => {
    const [row] = csvToRows("__proto__,title,constructor\npolluted,Cat Mug,bad");
    expect(row.title).toBe("Cat Mug");
    expect(Object.prototype.hasOwnProperty.call(row, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, "constructor")).toBe(false);
    expect({}.polluted).toBeUndefined(); // global prototype not polluted
  });

  it("M-6: caps absurdly long cells", () => {
    const huge = "x".repeat(200_000);
    const [row] = csvToRows(`title\n${huge}`);
    expect(row.title.length).toBe(100_000);
  });

  it("M-4: streamed header+rows equal rowsToCsv (cursor export parity)", () => {
    const rows = [
      { url: "https://www.etsy.com/listing/1/a", title: "Mug", favorites: 12 },
      { url: "https://www.etsy.com/listing/2/b", title: "=Bad", demandText: "+5 carts" },
    ];
    const streamed = [csvHeaderLine(), ...rows.map((r) => csvRowLine(r))].join("\n");
    expect(streamed).toBe(rowsToCsv(rows));
  });
});
