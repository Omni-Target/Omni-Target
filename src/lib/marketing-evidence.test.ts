import { describe, it, expect } from "vitest";
import { summarizeMarketingHistory, getMarketingHistoryTip } from "./marketing-evidence";
import type { StoreMarketingEvidence } from "./store-data";

describe("summarizeMarketingHistory", () => {
  it("handles undefined or empty history with a clear first-time cold acquisition notice", () => {
    expect(summarizeMarketingHistory(undefined)).toContain("first dedicated cold acquisition test");
    expect(summarizeMarketingHistory([])).toContain("first dedicated cold acquisition test");
  });

  it("summarizes campaigns with recorded spend and currency", () => {
    const history: StoreMarketingEvidence[] = [
      {
        id: "1",
        source: "integrated_campaign",
        title: "Spring Promo Meta",
        channel: "SOCIAL",
        spend: 450000,
        currency: "NGN",
      },
      {
        id: "2",
        source: "integrated_campaign",
        title: "Google Search Brand",
        channel: "SEARCH",
        spend: 120000,
        currency: "NGN",
      },
    ];

    const result = summarizeMarketingHistory(history);
    expect(result).toContain("Prior marketing activity recorded in Shopify");
    expect(result).toContain("Spring Promo Meta (Spend: 450,000 NGN)");
    expect(result).toContain("Google Search Brand (Spend: 120,000 NGN)");
    expect(result).toContain("prior paid media experience");
  });

  it("summarizes marketing channels without spend", () => {
    const history: StoreMarketingEvidence[] = [
      {
        id: "1",
        source: "marketing_event",
        type: "EMAIL",
        channel: "Klaviyo",
        title: "Welcome Flow",
      },
      {
        id: "2",
        source: "marketing_event",
        type: "SOCIAL",
        channel: "Instagram",
      },
    ];

    const result = summarizeMarketingHistory(history);
    expect(result).toContain("Past marketing activity recorded in Shopify across channels");
    expect(result).toContain("Klaviyo");
    expect(result).toContain("Instagram");
    expect(result).toContain("expanding acquisition push");
  });
});

describe("getMarketingHistoryTip", () => {
  it("returns a 7-day learning phase tip for first-time advertisers", () => {
    expect(getMarketingHistoryTip([])).toContain("7 full days to exit the learning phase");
    expect(getMarketingHistoryTip(undefined)).toContain("7 full days to exit the learning phase");
  });

  it("returns a scale tip when prior ad spend is detected", () => {
    const history: StoreMarketingEvidence[] = [
      {
        id: "1",
        source: "integrated_campaign",
        spend: 50000,
        currency: "NGN",
      },
    ];
    expect(getMarketingHistoryTip(history)).toContain("Past ad campaigns detected in Shopify");
  });

  it("returns an organic expansion tip when non-spend marketing events exist", () => {
    const history: StoreMarketingEvidence[] = [
      {
        id: "1",
        source: "marketing_event",
        channel: "EMAIL",
      },
    ];
    expect(getMarketingHistoryTip(history)).toContain("Prior organic/marketing activity detected in Shopify");
  });
});
