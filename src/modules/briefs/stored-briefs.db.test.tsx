// @vitest-environment jsdom
// jsdom, as in the browser: buildBriefPdfPayload has a browser-only branch.
import { afterAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

// The PDF embeds the product image from gatewayInsight, which trimming never
// touches, by downloading it; a download that times out in one render but not
// the other would look like a difference. Every render gets the same image.
vi.mock("@/lib/safe-image-fetch", () => ({
  fetchSafeImage: async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { headers: { "content-type": "image/jpeg" } }),
}));
import { trimStoredBrief } from "./evidence";
import { renderSavedBrief } from "./brief-renderings";

/**
 * Release verification for task 9, run against a restored copy of real data
 * before trimming it (scripts/ops/runbooks/brief-archive.md):
 *
 *   VERIFY_STORED_BRIEFS=1 TEST_DATABASE_URL=postgresql://...@127.0.0.1/<restored copy> pnpm test:db src/modules/briefs
 *
 * Every saved campaign and version that still carries a store snapshot must
 * render exactly the same once trimmed: PDF payload and HTML, copied text,
 * budget plan and the brief view. Skipped unless VERIFY_STORED_BRIEFS is set.
 */
const enabled = process.env.VERIFY_STORED_BRIEFS === "1";
const url = process.env.TEST_DATABASE_URL ?? "";

describe.skipIf(!enabled)("saved briefs render identically once trimmed (release verification)", () => {
  if (enabled && !/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Verification runs only against a local restored copy.");
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  afterAll(() => pool.end());

  it("covers every untrimmed campaign and version", async () => {
    const { rows } = await pool.query(`
      select 'campaign' as kind, c.id, c.brief_data, c.product_name, c.brand_name, c.campaign_goal, c.product_price, c.cta
        from public.campaigns c
       where jsonb_typeof(c.brief_data -> 'storeInsights') = 'object' and not (c.brief_data -> 'storeInsights' ? 'evidence_version')
      union all
      select 'version', v.id, v.brief_data, c.product_name, c.brand_name, c.campaign_goal, c.product_price, coalesce(v.cta, c.cta)
        from public.campaign_brief_versions v join public.campaigns c on c.id = v.campaign_id
       where jsonb_typeof(v.brief_data -> 'storeInsights') = 'object' and not (v.brief_data -> 'storeInsights' ? 'evidence_version')`);
    expect(rows.length, "no untrimmed briefs found: is this the right database?").toBeGreaterThan(0);

    const differences: string[] = [];
    for (const row of rows) {
      const trimmed = trimStoredBrief("brief", row.brief_data, row.product_name);
      const [before, after] = await Promise.all([renderSavedBrief(row.brief_data, row), renderSavedBrief(trimmed!, row)]);
      for (const part of ["payload", "html", "text", "plan", "markup"] as const) {
        if (JSON.stringify(before[part]) !== JSON.stringify(after[part])) differences.push(`${row.kind} ${row.id}: ${part}`);
      }
    }
    console.log(`Verified ${rows.length} saved briefs (${rows.filter((r) => r.kind === "campaign").length} campaigns, ${rows.filter((r) => r.kind === "version").length} versions).`);
    expect(differences).toEqual([]);
  });
});
