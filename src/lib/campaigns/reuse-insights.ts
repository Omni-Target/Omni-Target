import type { MetaRecommendations } from "@/lib/insights-engine";

/** A voice change should reuse the product's saved audience, budget and hooks. */
export function reusableRecommendationsFromVersions(
  versions: Array<{ brief_data?: unknown }>,
  productName: string,
  campaignGoal: string,
): MetaRecommendations | null {
  for (let i = versions.length - 1; i >= 0; i--) {
    const context = versions[i]?.brief_data;
    if (!context || typeof context !== "object" || Array.isArray(context)) continue;
    const saved = context as Record<string, unknown>;
    if (saved.productName !== productName || saved.goal !== campaignGoal) continue;
    const insights = saved.aiInsights;
    if (!insights || typeof insights !== "object" || Array.isArray(insights)) continue;
    const candidate = insights as Record<string, unknown>;
    if (Array.isArray(candidate.creative_hooks) &&
        candidate.targeting && typeof candidate.targeting === "object" &&
        candidate.budget && typeof candidate.budget === "object" &&
        candidate.advantage_plus_guidance && typeof candidate.advantage_plus_guidance === "object") {
      return insights as MetaRecommendations;
    }
  }
  return null;
}
