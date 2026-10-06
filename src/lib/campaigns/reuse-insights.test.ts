import { describe, expect, it } from "vitest";
import { reusableRecommendationsFromVersions } from "./reuse-insights";

const insights = {
  creative_hooks: [],
  targeting: { locations: [] },
  budget: { recommended_daily: 100 },
  advantage_plus_guidance: { campaign_type: "Sales" },
};

describe("reusableRecommendationsFromVersions", () => {
  it("reuses saved targeting for a voice variation", () => {
    expect(reusableRecommendationsFromVersions([
      { brief_data: { productName: "Ego Pants", goal: "Drive Website Sales", aiInsights: insights } },
    ], "Ego Pants", "Drive Website Sales")).toBe(insights);
  });

  it("falls back when product context or saved insights are missing", () => {
    expect(reusableRecommendationsFromVersions([
      { brief_data: { productName: "Other Product", goal: "Drive Website Sales", aiInsights: insights } },
    ], "Ego Pants", "Drive Website Sales")).toBeNull();
    expect(reusableRecommendationsFromVersions([
      { brief_data: { productName: "Ego Pants", goal: "Drive Website Sales", aiInsights: { targeting: {} } } },
    ], "Ego Pants", "Drive Website Sales")).toBeNull();
  });
});
