import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Real Postgres tests (Phase 1, task 2). Separate from the unit suite because
// they need TEST_DATABASE_URL pointing at a freshly provisioned database.
// `src/**/*.db.test.ts` run application modules (with injected ports) against it.
export default defineConfig({
  test: {
    environment: "node",
    include: ["supabase/tests/**/*.db.test.mjs", "src/**/*.db.test.ts"],
    testTimeout: 30_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
    },
  },
});
