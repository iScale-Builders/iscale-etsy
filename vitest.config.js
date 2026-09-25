import { defineConfig } from "vitest/config";

const smoke = process.env.ETSY_E2E_CHROME === "1" ? [] : ["tests/extension-smoke.test.js"];

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.js"],
    exclude: ["node_modules", "dist", ...smoke],
  },
});
