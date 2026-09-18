import { describe, it, expect } from "vitest";
import {
  getChannelBehavioralGuidance,
  getGeographicBuyingDynamics,
  parseBudgetReasoning,
} from "./qualitative-guidance";

describe("getChannelBehavioralGuidance", () => {
  it("returns empty string when channel is not provided", () => {
    expect(getChannelBehavioralGuidance(undefined)).toBe("");
    expect(getChannelBehavioralGuidance(null)).toBe("");
  });

  it("handles Instagram with visual discovery scroll guidance", () => {
    const result = getChannelBehavioralGuidance("Instagram", 48);
    expect(result).toContain("Instagram (48% of historical store orders)");
    expect(result).toContain("visual scrolling mode");
    expect(result).toContain("tactile movement, fabric drape");
  });

  it("handles TikTok with candid UGC authenticity guidance", () => {
    const result = getChannelBehavioralGuidance("TikTok", 35);
    expect(result).toContain("TikTok (35% of historical store orders)");
    expect(result).toContain("UGC-style problem-solution framing");
  });

  it("handles Google Search with high purchase intent guidance", () => {
    const result = getChannelBehavioralGuidance("Google / Search", 50);
    expect(result).toContain("Google / Search (50% of historical store orders)");
    expect(result).toContain("high purchase intent");
    expect(result).toContain("functional clarity");
  });

  it("handles Email Marketing with high trust and community affinity", () => {
    const result = getChannelBehavioralGuidance("Email Marketing", 20);
    expect(result).toContain("Email Marketing (20% of historical store orders)");
    expect(result).toContain("high-trust relationship");
  });

  it("handles Direct / Organic with brand prestige guidance", () => {
    const result = getChannelBehavioralGuidance("Direct / Organic", 60);
    expect(result).toContain("Direct / Organic (60% of historical store orders)");
    expect(result).toContain("organic prestige");
  });
});

describe("getGeographicBuyingDynamics", () => {
  it("returns empty string when locations are empty", () => {
    expect(getGeographicBuyingDynamics("NG", "NGN", [])).toBe("");
    expect(getGeographicBuyingDynamics("NG", "NGN", null)).toBe("");
  });

  it("detects cross-border export demand for a Nigerian store with US & UK buyers", () => {
    const locations = [
      { city: "Lagos", country: "Nigeria", percentage: 87 },
      { city: "New York", country: "United States", percentage: 8 },
      { city: "London", country: "United Kingdom", percentage: 3 },
    ];
    const result = getGeographicBuyingDynamics("Nigeria", "NGN", locations);
    expect(result).toContain("CROSS-BORDER & EXPORT BUYING DYNAMICS");
    expect(result).toContain("Lagos");
    expect(result).toContain("New York (United States)");
    expect(result).toContain("cosmopolitan crossover appeal");
  });

  it("detects localized core market focus for a US domestic store", () => {
    const locations = [
      { city: "New York", country: "United States", percentage: 60 },
      { city: "Los Angeles", country: "United States", percentage: 30 },
      { city: "Chicago", country: "United States", percentage: 10 },
    ];
    const result = getGeographicBuyingDynamics("United States", "USD", locations);
    expect(result).toContain("LOCALIZED CORE MARKET FOCUS");
    expect(result).toContain("New York, Los Angeles, Chicago");
  });
});

describe("parseBudgetReasoning", () => {
  it("returns empty object for empty or missing string", () => {
    expect(parseBudgetReasoning("")).toEqual({});
  });

  it("parses full multi-part reasoning into clean structured components", () => {
    const raw =
      "Calibrated for your product's ₦230,000 price point: Higher-value pieces take more browsing before shoppers buy. Starting lower makes it hard. Recommended Plan: 1 consolidated ad set at ₦14,238/day focused on your primary domestic market.\n\n💡 Optional Overseas Expansion: Should you ever wish to test overseas sales in London · New York, launch a separate overseas ad set at ₦33,222/day). You do not need to run both at once.\n\n💡 Cash Flow Tip: Your recent 30-day store sales were ₦253,250. If cash flow is tight, choose the Dip Your Toe option (₦9,967/day) to test with less risk.";

    const parsed = parseBudgetReasoning(raw);
    expect(parsed.calibrationTitle).toBe("Calibrated for your product's ₦230,000 price point:");
    expect(parsed.calibrationBody).toContain("Higher-value pieces take more browsing");
    expect(parsed.recommendedPlan).toBe(
      "1 consolidated ad set at ₦14,238/day focused on your primary domestic market."
    );
    expect(parsed.overseasExpansion).toContain(
      "Should you ever wish to test overseas sales in London · New York"
    );
    expect(parsed.overseasExpansion).not.toContain(").");
    expect(parsed.cashFlowTip).toContain(
      "Your recent 30-day store sales were ₦253,250"
    );
    expect(parsed.recentRevenueFormatted).toBe("₦253,250");
    expect(parsed.dipDailyFormatted).toBe("₦9,967/day");
  });

  it("handles simple text gracefully in rawFallback", () => {
    const raw = "Spend $20/day to test initial conversion volume.";
    const parsed = parseBudgetReasoning(raw);
    expect(parsed.rawFallback).toBe(raw);
  });
});
