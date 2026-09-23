import type { StoreMarketingEvidence } from "./store-data";

/**
 * Summarizes Shopify marketing events and integrated ad campaigns
 * into a grounded, actionable context string for the AI prompt.
 */
export function summarizeMarketingHistory(
  history?: StoreMarketingEvidence[]
): string {
  if (!history || history.length === 0) {
    return "No recorded third-party ad spend or integrated marketing activities in Shopify. Treat this as the merchant's first dedicated cold acquisition test on Meta Advantage+ (emphasize the 7-day learning phase and establishing baseline metrics).";
  }

  // Extract campaigns with recorded ad spend
  const spendCampaigns = history.filter(
    (item) => item.spend != null && item.spend > 0
  );

  // Extract unique channels and tactics
  const uniqueChannels = [
    ...new Set(
      history
        .map((item) => item.channel || item.source_and_medium || item.type)
        .filter((val): val is string => Boolean(val && val.trim()))
    ),
  ];

  if (spendCampaigns.length > 0) {
    const spendSummaries = spendCampaigns.slice(0, 3).map((c) => {
      const title = c.title || c.channel || "Campaign";
      const spendText = c.spend ? `Spend: ${c.spend.toLocaleString()} ${c.currency || ""}`.trim() : "";
      return spendText ? `${title} (${spendText})` : title;
    });

    const channelStr = uniqueChannels.length > 0 ? `across ${uniqueChannels.slice(0, 4).join(", ")}` : "";
    return `Prior marketing activity recorded in Shopify ${channelStr}. Recent campaigns with recorded spend: ${spendSummaries.join("; ")}. Use this context knowing the brand has prior paid media experience.`;
  }

  if (uniqueChannels.length > 0) {
    const titles = history
      .map((item) => item.title)
      .filter((title): title is string => Boolean(title && title.trim()))
      .slice(0, 3);
    const titleSnippet = titles.length ? ` (e.g. ${titles.join(", ")})` : "";
    return `Past marketing activity recorded in Shopify across channels: ${uniqueChannels.slice(0, 4).join(", ")}${titleSnippet}. No direct ad spend amounts recorded in Shopify; treat this as an expanding acquisition push.`;
  }

  return "Limited Shopify marketing activity recorded. Treat this as an expanding cold acquisition test.";
}

/**
 * Generates an actionable, founder-friendly tip for the brief's Store Context section
 * based on the merchant's marketing history.
 */
export function getMarketingHistoryTip(
  history?: StoreMarketingEvidence[]
): string | null {
  if (!history || history.length === 0) {
    return "First-time Meta paid acquisition campaign: Allow Meta's Advantage+ algorithm 7 full days to exit the learning phase before making budget adjustments.";
  }

  const hasSpend = history.some((item) => item.spend != null && item.spend > 0);
  if (hasSpend) {
    return "Past ad campaigns detected in Shopify: Meta Advantage+ will scale broader cold acquisition alongside your existing marketing channels.";
  }

  return "Prior organic/marketing activity detected in Shopify: This Advantage+ campaign will introduce your brand to cold, high-intent prospects at scale.";
}
