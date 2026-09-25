// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JOB_TYPES } from "../src/core/worker-commands.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const background = readFileSync(join(root, "background.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const workerPage = readFileSync(join(root, "worker-page.js"), "utf8");
const passive = readFileSync(join(root, "passive.js"), "utf8");
const runbook = readFileSync(join(root, "docs/worker-runbook.md"), "utf8");

describe("worker mode wiring", () => {
  it("opens a visible Etsy tab and polls on its own alarm", () => {
    expect(background).toContain('const WORKER_POLL_ALARM = "etsy-worker-poll"');
    expect(background).toContain("if (alarm.name === WORKER_POLL_ALARM) onWorkerAlarm()");
    expect(background).toContain("periodInMinutes: workerAlarmDelayMinutes(cfg.pollSeconds)");
    expect(background).not.toMatch(/WORKER_POLL_ALARM,\s*\{\s*delayInMinutes/);
    expect(background).toContain("if (state.loopAlive || state.launching || state.workerScanning) return false");
    expect(background).not.toContain("if (state.loopAlive || state.launching || state.workerScanning || state.workerPausing) return false");
    expect(background).toContain("if (state.workerScanning || state.workerPausing || state.loopAlive || state.launching) return");
    expect(background).toContain("state.workerPausing = true");
    expect(background).toContain("state.workerScanning = false");
    expect(background).toContain("localRunnerBusy: state.loopAlive || state.launching");
    expect(background).toContain('setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })');
    expect(background).toContain("chrome.storage.session.get(WORKER_AUTH_KEY)");
    expect(background).toContain("chrome.storage.session.set({ [WORKER_AUTH_KEY]: next })");
    expect(background).toContain("chrome.storage.local.remove(WORKER_AUTH_KEY)");
    expect(background).toContain("chrome.storage.local.get(WORKER_CLAIM_TIMES_KEY)");
    expect(background).toContain("chrome.storage.local.set({ [WORKER_CLAIM_TIMES_KEY]: times })");
    expect(background).not.toContain("chrome.storage.local.set({ [WORKER_AUTH_KEY]");
    expect(background).toContain("realtimeAccessTokenMessage");
    expect(background).toContain("laneWhoami()");
    expect(background).toContain("cfg.heartbeatSeconds * 1000");
    expect(background).toContain("validateSavedWorkerTab");
    expect(background).toContain("workerTabReusable");
    expect(background).toContain("redactWorkerCredentials(settings)");
    expect(background).toContain("release: true");
    expect(background).toMatch(/chrome\.tabs\.create\(\{\s*url:\s*"https:\/\/www\.etsy\.com\/",\s*active:\s*true\s*\}\)/);
    expect(background).toContain('action: "worker.typeAndSubmit"');
    expect(background).toContain("runWorkerJob");
    expect(background).toContain('action: "worker.detectBlock"');
    expect(background).toContain('action: "worker.extractShop"');
    expect(background).toContain('action: "listing.extract"');
    expect(passive).toContain('startsWith("worker.")');
    expect(background).toContain("chrome.storage.session");
    expect(background).not.toMatch(/puppeteer|playwright|--headless/);
  });

  it("keeps the local runner tab in the background", () => {
    expect(background).toMatch(/chrome\.tabs\.create\(\{\s*url:\s*"https:\/\/www\.etsy\.com",\s*active:\s*false\s*\}\)/);
  });

  it("ships worker mode off, with storage only and an optional backend host grant", () => {
    expect(manifest.permissions).toContain("storage");
    expect(manifest.optional_host_permissions).toContain("https://*/*");
    expect(manifest.host_permissions).toEqual(["https://*.etsy.com/*"]);
    expect(manifest.options_ui.page).toBe("options.html");
    expect(workerPage).toContain("typeAndSubmitSearch");
    expect(workerPage).toContain("formatSearchPathLog");
    expect(workerPage).toContain("worker.detectBlock");
    expect(workerPage).toContain("parseShopPage");
  });

  it("documents every job type and the features left local", () => {
    for (const type of JOB_TYPES) expect(runbook).toContain(`\`${type}\``);
    expect(runbook).toContain("Features left on the machine");
    expect(runbook).toContain("Clear collection");
    expect(runbook).toContain("Import CSV");
    expect(runbook).not.toMatch(/disable public signups/i);
    expect(runbook).toContain("operators table is the access gate");
    expect(runbook).toContain("lane_name");
    expect(runbook).toContain("chrome.storage.session");
    expect(runbook).toContain("TRUSTED_CONTEXTS");
    expect(runbook).toContain("supabase/preflight-etsy-worker.sql");
    expect(runbook).toContain("supabase/apply-etsy-worker.sql");
    expect(runbook).toContain("etsyWorkerClaimTimes");
  });
});
