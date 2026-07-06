import { describe, it, expect } from "vitest";
import { hashText } from "../src/core/hash.js";

describe("hashText (stable id primitive — must not drift)", () => {
  it("is deterministic for the same input", () => {
    expect(hashText("etsy")).toBe(hashText("etsy"));
  });
  it("differs for different inputs", () => {
    expect(hashText("a")).not.toBe(hashText("b"));
  });
  it("coerces non-strings without throwing, returns base36", () => {
    expect(typeof hashText(null)).toBe("string");
    expect(typeof hashText(undefined)).toBe("string");
    expect(hashText(12345)).toMatch(/^[0-9a-z]+$/);
  });
  // Pinned outputs — a change here means existing queue/job/import IDs would shift.
  it("pins known values (guards against algorithm drift)", () => {
    expect(hashText("etsy")).toBe("1uyj9");
    expect(hashText("https://www.etsy.com/listing/123/x")).toBe("s6tunj");
  });
});
