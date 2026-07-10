import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = existsSync(join(process.cwd(), "background.js")) ? process.cwd() : join(process.cwd(), "public-etsy-scraper-v5");
const source = readFileSync(join(packageRoot, "background.js"), "utf8");

describe("shipping background lifecycle wiring", () => {
  it("preserves an existing auto-run countdown during worker initialization", () => {
    expect(source).toMatch(/scheduleQueueRun\(settings,\s*\{\s*preserveExisting:\s*true\s*\}\)/);
    expect(source).toContain("queueAlarmDecision");
  });

  it("stops the API heartbeat before every deliberate runJob yield", () => {
    expect(source.match(/stopKeepAlivePing\(\);/g)?.length).toBeGreaterThanOrEqual(4);
    expect(source).toMatch(/stopKeepAlivePing\(\);\s*return;\s*\/\/ ONE listing visited/);
  });

  it("wires a dedicated term-gap alarm into the live runner", () => {
    expect(source).toContain('const TERM_GAP_ALARM = "etsy-term-gap"');
    expect(source).toContain("await scheduleTermGapResume(until)");
    expect(source).toContain("if (alarm.name === TERM_GAP_ALARM) onTermGapAlarm()");
  });

  it("persists and restores the hidden runner tab across worker restarts", () => {
    expect(source).toContain("runnerTabCandidates(state.tabId, settings.runnerTabId)");
    expect(source).toMatch(/chrome\.tabs\.get\(tabId\)/);
    expect(source).toMatch(/saveSettings\(\{\s*runnerTabId:\s*tab\.id\s*\}\)/);
  });

  it("enforces sender-role authorization before dispatch", () => {
    const auth = source.indexOf("authorizeMessageSender({");
    const dispatch = source.indexOf("handleMessage(message, sender)");
    expect(auth).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(auth);
  });
});
