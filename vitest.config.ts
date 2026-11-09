import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // jsdom so the `typeof window !== "undefined"` branch in buildBriefPdfPayload
    // (the budget-reasoning rewrite) is actually exercised, matching the browser.
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Real Postgres tests run in the Database job (vitest.db.config.mjs).
    exclude: ["**/node_modules/**", "src/**/*.db.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
    },
  },
});
