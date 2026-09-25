// Opt-in Chrome smoke test. Default `npm test` does not download a browser.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
const child = spawn(process.execPath, [vitest, "run", "tests/extension-smoke.test.js"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ETSY_E2E_CHROME: "1" },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
