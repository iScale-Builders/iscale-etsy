// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../vitest.config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("extension smoke opt-in", () => {
  it("keeps the Chrome download out of the default test run", () => {
    expect(process.env.ETSY_E2E_CHROME).not.toBe("1");
    expect(config.test.exclude).toContain("tests/extension-smoke.test.js");
    const smoke = readFileSync(join(root, "tests/extension-smoke.test.js"), "utf8");
    expect(smoke).toContain("describe.skipIf(!chromeSmoke)");
    expect(smoke).toContain('process.env.ETSY_E2E_CHROME === "1"');
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts["test:e2e"]).toBe("node scripts/run-extension-smoke.mjs");
    const runner = readFileSync(join(root, "scripts/run-extension-smoke.mjs"), "utf8");
    expect(runner).toContain('ETSY_E2E_CHROME: "1"');
  });
});
