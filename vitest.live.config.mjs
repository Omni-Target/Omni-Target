import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Opt-in checks against staging and a real Shopify shop (Phase 2). Never part
// of CI or the unit suite. Run with the staging environment, for example:
//   LIVE_SHOP_DOMAIN=<shop>.myshopify.com node --env-file=.env.local \
//     node_modules/vitest/vitest.mjs run --config vitest.live.config.mjs
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.live.test.ts"],
    testTimeout: 120_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
    },
  },
});
