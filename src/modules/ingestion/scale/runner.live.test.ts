/**
 * One import run in its own process, for the scale verification's kill test
 * (Phase 2, task 12): scale.live.test.ts starts this file and kills it with
 * SIGKILL mid-batch. Runs only with the SCALE_* variables it sets.
 */
import { describe, it } from "vitest";

describe.skipIf(!process.env.SCALE_IMPORT_ID)("scale import runner (task 12)", () => {
  it("runs one import against the fake Shopify", async () => {
    const { requireLocal, fakeImportDeps } = await import("./harness");
    requireLocal(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL");
    const { runShopImport } = await import("../workflow");
    await runShopImport(process.env.SCALE_IMPORT_ID!, process.env.SCALE_RUN_ID!, async () => {}, fakeImportDeps(process.env.SCALE_FAKE_URL!));
  }, 7_200_000);
});
