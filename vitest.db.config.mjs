import { defineConfig } from "vitest/config";

// Real Postgres tests (Phase 1, task 2). Separate from the unit suite because
// they need TEST_DATABASE_URL pointing at a freshly provisioned database.
export default defineConfig({
  test: {
    environment: "node",
    include: ["supabase/tests/**/*.db.test.mjs"],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
