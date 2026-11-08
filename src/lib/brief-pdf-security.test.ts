import { describe, expect, it } from "vitest";
import { buildBriefPdfPayload } from "@/lib/campaigns/brief";
import { buildBriefHTML } from "@/lib/brief-html-template";
import { checkBoundedJson, parseBriefPdfParams } from "@/lib/brief-pdf-schema";
import type { BriefPDFParams } from "@/lib/brief-pdf-types";
import { isAllowedRenderRequest } from "@/lib/pdf/render-pdf";
import type { AiInsights, GeneratedCopy } from "@/components/campaigns/types";

const copy: GeneratedCopy = {
  headline: "Big Sale",
  primaryText: "Shop the collection now.",
  description: "Premium everyday wear.",
  cta: "Shop Now",
  copywriterNote: "Lead with value.",
};

const insights = {
  advantage_plus_guidance: {
    campaign_type: "Manual Sales with Advantage+ Audience",
    optimization_event: "Purchase",
    optimization_reasoning: "Purchase is the sales-goal hypothesis.",
    seed_audience_suggestions: {
      age_min: 25,
      age_max: 45,
      gender: "Women",
      demographic_justification: "Matches store purchasing history.",
      seed_interests: ["Fashion"],
    },
  },
  targeting: { locations: [{ name: "Lagos" }], age_min: 25, age_max: 45, gender: "Women", interests: ["Fashion"] },
  budget: {
    currency: "USD",
    reasoning: "Start moderate.",
    ad_sets: 1,
    recommended_daily: 20,
    optimization_event: { event: "Purchase", reasoning: "Best signal." },
    breakdown: { goal_multipliers: { "Drive Website Sales": 1 } },
    strategies: [{ label: "Balanced", daily: 20, total_daily: 20, description: "" }],
  },
  timing: { peak_days: ["Friday"], launch_recommendation: "Launch Friday.", reasoning: "Peak day." },
  warnings: [],
} as unknown as AiInsights;

function realPayload(): BriefPDFParams {
  return buildBriefPdfPayload({
    brandName: "Acme",
    productName: "Tee",
    goal: "Drive Website Sales",
    generatedCopy: copy,
    selectedCta: "Shop Now",
    aiInsights: insights,
    storeInsights: null,
    selectedDuration: 14,
    selectedStrategyIndex: 0,
    gatewayInsight: null,
    isNewLaunch: false,
  } as unknown as Parameters<typeof buildBriefPdfPayload>[0]);
}

describe("PDF payload schema (SEC-06)", () => {
  it("accepts payloads produced by the real client builder", () => {
    const result = parseBriefPdfParams(JSON.parse(JSON.stringify(realPayload())));
    expect(result.ok).toBe(true);
  });

  type Draft = { [key: string]: unknown; budget: Record<string, unknown>; copy?: Record<string, unknown> };

  it.each<[string, (p: Draft) => void]>([
    ["an HTML currency symbol", (p) => void (p.budget.currency_symbol = "<img src=x onerror=alert(1)>")],
    ["a non-ISO currency", (p) => void (p.budget.currency = "usd<script>")],
    ["a javascript: product URL", (p) => void (p.productUrl = "javascript:alert(document.cookie)")],
    ["a number sent as markup", (p) => void (p.budget.recommended_daily = "<img src=x onerror=alert(1)>")],
    ["a missing required field", (p) => void delete p.copy],
    ["an oversized string", (p) => void (p.copy!.primaryText = "x".repeat(25_000))],
  ])("rejects %s", (_label, mutate) => {
    const payload = JSON.parse(JSON.stringify(realPayload())) as Draft;
    mutate(payload);
    const result = parseBriefPdfParams(payload);
    expect(result.ok).toBe(false);
  });

  it("bounds nesting and size of arbitrary extra fields", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 20; i += 1) {
      deep.next = {};
      deep = deep.next as Record<string, unknown>;
    }
    expect(checkBoundedJson(root)).toMatch(/nested too deeply/);
    expect(checkBoundedJson({ list: new Array(600).fill(1) })).toMatch(/too many items/);
  });
});

describe("brief HTML output (SEC-06 sink hardening)", () => {
  it("embeds a strict CSP and no script at all in the preview/PDF variant", async () => {
    const html = await buildBriefHTML(realPayload(), { embed: true });
    expect(html).toContain(`http-equiv="Content-Security-Policy"`);
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain("script-src");
    expect(html.toLowerCase()).not.toContain("<script");
  });

  it("escapes injected markup in free-text fields and the currency symbol (even if validation were bypassed)", async () => {
    const payload = realPayload();
    payload.brandName = `<img src=x onerror=alert(1)>`;
    payload.productName = `"'><svg onload=alert(2)>`;
    payload.budget.currency_symbol = "<b>X</b>";
    if (payload.advantage_plus_guidance) {
      payload.advantage_plus_guidance.seed_audience_suggestions.gender = "<i>All</i>" as never;
    }
    const html = await buildBriefHTML(payload, { embed: true });
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<svg onload=alert(2)>");
    expect(html).not.toContain("<b>X</b>");
    expect(html).not.toContain("<i>All</i>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("never renders a non-http(s) product link", async () => {
    const payload = realPayload();
    payload.productUrl = "javascript:alert(document.cookie)";
    const html = await buildBriefHTML(payload, { embed: true });
    expect(html).not.toContain("javascript:alert");
  });

  it("standalone variant: print helper runs only under a matching nonce, with no inline handlers", async () => {
    const html = await buildBriefHTML(realPayload(), { embed: false });
    const nonce = html.match(/script-src 'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).not.toMatch(/onclick=/i);
  });
});

describe("PDF renderer network isolation (SEC-06)", () => {
  it.each([
    ["data:font/woff2;base64,AAAA", true],
    ["about:blank", true],
    ["http://169.254.169.254/latest/meta-data/", false],
    ["http://localhost:3000/", false],
    ["https://evil.example/beacon.png", false],
    ["file:///etc/passwd", false],
    ["ws://internal:8080/", false],
  ])("isAllowedRenderRequest(%s) === %s", (url, allowed) => {
    expect(isAllowedRenderRequest(url)).toBe(allowed);
  });
});
