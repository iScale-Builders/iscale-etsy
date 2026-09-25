// @vitest-environment node
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Browser,
  ChromeReleaseChannel,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
  resolveBuildId,
} from "@puppeteer/browsers";
import { describe, expect, it } from "vitest";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Branded Chrome 137+ ignores --load-extension. Chrome for Testing still honors it.
async function chromeForTesting() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cacheDir = join(tmpdir(), "iscale-etsy-chrome");
  const platform = detectBrowserPlatform();
  const buildId = await resolveBuildId(Browser.CHROME, platform, ChromeReleaseChannel.STABLE);
  const executablePath = computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir, platform });
  if (!existsSync(executablePath)) {
    await install({ browser: Browser.CHROME, buildId, cacheDir, platform });
  }
  return executablePath;
}

const fixture = `<!doctype html>
<html>
  <head><title>Etsy search fixture</title></head>
  <body>
    <h1>1,248 results</h1>
    <a href="/listing/1111111111/linen-apron"><h3>Linen apron</h3></a>
  </body>
</html>`;

const chromeSmoke = process.env.ETSY_E2E_CHROME === "1";

describe.skipIf(!chromeSmoke)("unpacked extension content script", () => {
  it("answers a content-script message on a static Etsy fixture", async () => {
    const executablePath = await chromeForTesting();
    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        `--disable-extensions-except=${root}`,
        `--load-extension=${root}`,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--disable-gpu",
      ],
    });
    try {
      const workerTarget = await browser.waitForTarget(
        (target) => target.type() === "service_worker" && target.url().endsWith("/background.js"),
        { timeout: 20000 },
      );
      const worker = await workerTarget.worker();
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = request.url();
        if (url.startsWith("https://www.etsy.com/")) {
          request.respond({ status: 200, contentType: "text/html; charset=utf-8", body: fixture }).catch(() => {});
          return;
        }
        request.continue().catch(() => {});
      });
      await page.goto("https://www.etsy.com/search?q=linen+apron", { waitUntil: "domcontentloaded", timeout: 20000 });

      let block = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        block = await worker.evaluate(async () => {
          const tabs = await chrome.tabs.query({ url: "https://*.etsy.com/*" });
          const tab = tabs.find((item) => String(item.url || "").includes("/search"));
          if (!tab?.id) return { error: "no_tab" };
          try {
            return await chrome.tabs.sendMessage(tab.id, { action: "worker.detectBlock" });
          } catch (error) {
            return { error: String(error?.message || error) };
          }
        });
        if (block && !block.error && block.block) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(block?.error).toBeUndefined();
      expect(block.block.blocked).toBe(false);

      const extracted = await worker.evaluate(async () => {
        const tabs = await chrome.tabs.query({ url: "https://*.etsy.com/*" });
        const tab = tabs.find((item) => String(item.url || "").includes("/search"));
        return chrome.tabs.sendMessage(tab.id, { action: "search.scrollAndExtract" });
      });
      expect(extracted.payload.results[0].listingId).toBe("1111111111");
      expect(extracted.payload.totalResults).toBe(1248);
      expect(extracted.block.blocked).toBe(false);
    } finally {
      await browser.close();
    }
  }, 60000);
});
