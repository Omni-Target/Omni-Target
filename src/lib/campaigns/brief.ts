import { formatCurrency } from "@/lib/currency";
import type {
  AiInsights,
  GeneratedCopy,
  StoreInsights,
} from "@/components/campaigns/types";
import type { BriefPDFParams } from "@/lib/generate-brief-pdf";

export interface BuildBriefPdfPayloadParams {
  brandName: string;
  productName: string;
  goal: string;
  generatedCopy: GeneratedCopy;
  selectedCta: string;
  aiInsights: AiInsights | null;
  storeInsights: StoreInsights | null;
  selectedDuration: number;
  selectedStrategyIndex: number;
  gatewayInsight: BriefPDFParams["gatewayInsight"] | null;
  isNewLaunch: boolean;
}

/**
 * Assembles the full {@link BriefPDFParams} payload sent to the PDF renderer,
 * including the goal-adjusted budget math and the limited-data warning. Pure.
 */
export function buildBriefPdfPayload({
  brandName,
  productName,
  goal,
  generatedCopy,
  selectedCta,
  aiInsights,
  storeInsights,
  selectedDuration,
  selectedStrategyIndex,
  gatewayInsight,
  isNewLaunch,
}: BuildBriefPdfPayloadParams): BriefPDFParams {
  let productUrl: string | undefined = undefined;
  if (storeInsights?.store?.domain) {
    const cp = storeInsights.products?.find((p) => p.name === productName);
    if (cp?.handle) {
      productUrl = `https://${storeInsights.store.domain}/products/${cp.handle}`;
    }
  }

  return {
    brandName,
    productName,
    productUrl,
    campaignGoal: goal,
    copy: {
      headline: generatedCopy.headline,
      primaryText: generatedCopy.primaryText,
      description: generatedCopy.description,
      cta: selectedCta || generatedCopy.cta,
      copywriterNote: generatedCopy.copywriterNote,
    },
    targeting: aiInsights?.targeting ?? {},
    budget: {
      ...(aiInsights?.budget ?? {}),
      recommended_duration_days: selectedDuration,
      recommended_daily:
        aiInsights?.budget?.strategies?.[selectedStrategyIndex]?.daily ??
        aiInsights?.budget?.recommended_daily,
      goal_adjusted_daily: aiInsights?.budget
        ? Math.round(
            (aiInsights.budget.strategies?.[selectedStrategyIndex]?.daily ??
              aiInsights.budget.recommended_daily ??
              0) *
              (aiInsights.budget.ad_sets || 1) *
              (aiInsights.budget.breakdown?.goal_multipliers?.[goal] ?? 1),
          )
        : undefined,
      goal_label:
        (aiInsights?.budget?.breakdown?.goal_multipliers?.[goal] ?? 1) !== 1
          ? goal.toLowerCase()
          : undefined,
      tier:
        aiInsights?.budget?.strategies?.[selectedStrategyIndex]?.label ??
        aiInsights?.budget?.tier,
      reasoning:
        typeof window !== "undefined" && aiInsights?.budget
          ? (() => {
              const strategies = aiInsights.budget.strategies || [];
              const currentStrategy =
                strategies[selectedStrategyIndex] || strategies[1];
              const baseDaily = currentStrategy.daily;
              const goalMult =
                aiInsights.budget.breakdown?.goal_multipliers?.[goal] ?? 1;
              const adjustedPerAdSet = Math.round(baseDaily * goalMult);
              const originalDaily = aiInsights.budget.recommended_daily;
              let res = aiInsights.budget.reasoning;
              if (originalDaily && originalDaily !== adjustedPerAdSet) {
                const curr = aiInsights.budget.currency;
                const oldStr = formatCurrency(
                  originalDaily,
                  curr,
                  aiInsights.budget.currency_symbol,
                );
                const newStr = formatCurrency(
                  adjustedPerAdSet,
                  curr,
                  aiInsights.budget.currency_symbol,
                );
                res = res.replace(oldStr, newStr);
              }
              return res;
            })()
          : aiInsights?.budget?.reasoning,
    } as BriefPDFParams["budget"],
    timing: aiInsights?.timing ?? {},
    warnings: (() => {
      const cp = storeInsights?.products?.find((p) => p.name === productName);
      const descLength = cp?.description?.trim().length ?? 0;
      const tagCount = cp?.tags?.length ?? 0;
      const orderCount = cp?.order_count ?? cp?.units_sold ?? 0;
      const storeOrderCount =
        storeInsights?.orders?.order_count ??
        storeInsights?.orders?.orders_last_30_days ??
        0;
      const w = [...(aiInsights?.warnings ?? [])];
      if (
        descLength < 30 ||
        tagCount < 2 ||
        orderCount < 5 ||
        storeOrderCount < 20
      ) {
        const warningMsg =
          "Limited product data detected — review interests before launching.";
        if (!w.includes(warningMsg)) w.push(warningMsg);
      }
      return w;
    })(),
    generatedAt: new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }),
    gatewayInsight: gatewayInsight ?? undefined,
    isNewLaunch,
  };
}

export interface BuildBriefTextParams {
  generatedCopy: GeneratedCopy;
  selectedCta: string;
  aiInsights: AiInsights | null;
  storeInsights: StoreInsights | null;
  goal: string;
  selectedStrategyIndex: number;
  selectedDuration: number;
}

/** Builds the plain-text campaign brief copied to the clipboard. Pure. */
export function buildBriefText({
  generatedCopy,
  selectedCta,
  aiInsights,
  storeInsights,
  goal,
  selectedStrategyIndex,
  selectedDuration,
}: BuildBriefTextParams): string {
  return [
    "═══ CAMPAIGN BRIEF ═══",
    "",
    "HEADLINE:",
    generatedCopy.headline,
    "",
    "PRIMARY TEXT:",
    generatedCopy.primaryText,
    "",
    "DESCRIPTION:",
    generatedCopy.description,
    "",
    "CTA: " + (selectedCta || generatedCopy.cta),
    "",
    "── TARGETING ──",
    aiInsights?.targeting?.locations &&
    aiInsights.targeting.locations.length > 0
      ? `Locations: ${aiInsights.targeting.locations.map((l) => l.name).join(", ")}`
      : "Locations: Set manually",
    `Age: ${aiInsights?.targeting?.age_min || 25} — ${aiInsights?.targeting?.age_max || 44}`,
    `Gender: ${aiInsights?.targeting?.gender || "All"}`,
    `Interests: ${aiInsights?.targeting?.interests?.join(", ") || "Set manually"}`,
    `Behaviours: ${(aiInsights?.targeting?.behaviours || ["Engaged Shoppers"]).join(", ")}`,
    "",
    "── BUDGET ──",
    aiInsights?.budget
      ? (() => {
          const strategies = aiInsights.budget.strategies || [];
          const currentS = strategies[selectedStrategyIndex] || strategies[1];
          const adSets = aiInsights.budget.ad_sets || 1;
          const gm = aiInsights.budget.breakdown?.goal_multipliers?.[goal] ?? 1;
          const adj = Math.round(currentS.daily * adSets * gm);
          const curr = aiInsights.budget.currency;
          return [
            `Strategy: ${currentS.label}`,
            `Optimization Event: ${aiInsights.budget.optimization_event?.event || "Purchase"}`,
            `Ad Sets: ${adSets}`,
            `Recommended Daily: ${formatCurrency(adj, curr, aiInsights.budget.currency_symbol)}/day`,
            `Test Duration: ${selectedDuration} days`,
            `Total Test Spend: ${formatCurrency(adj * selectedDuration, curr, aiInsights.budget.currency_symbol)}`,
            `Meta Context: ${aiInsights.budget.reasoning}`,
          ]
            .filter(Boolean)
            .join("\n");
        })()
      : `Recommended starting budget: ${formatCurrency(5000, storeInsights?.store?.currency || "USD", storeInsights?.store?.currency_symbol)}/day for 14 days`,
    aiInsights?.budget?.reasoning || "Set final budget in Meta Ads Manager",
    "",
    "── TIMING ──",
    storeInsights?.orders?.peak_days &&
    storeInsights.orders.peak_days.length > 0
      ? `Best days: ${storeInsights.orders.peak_days.join(", ")}`
      : "No timing data yet",
    "",
    "Generated by Omni Target",
  ].join("\n");
}
