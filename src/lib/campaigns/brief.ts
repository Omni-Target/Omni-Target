import { formatCurrency } from "@/lib/currency";
import type {
  AiInsights,
  GeneratedCopy,
  StoreInsights,
} from "@/components/campaigns/types";
import type {
  BriefPDFParams,
  CreativeHook,
  AdvantagePlusGuidance,
  ImplementationStep,
} from "@/lib/brief-pdf-types";
import { getAdvantagePlusGuidance } from "@/lib/advantage-plus";
import { getInternationalStrategies } from "@/lib/market-geography";

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
  selectedIntlStrategyIndex?: number;
  gatewayInsight: BriefPDFParams["gatewayInsight"] | null;
  isNewLaunch: boolean;
}

/**
 * Assembles the full {@link BriefPDFParams} payload sent to the PDF renderer,
 * formatted according to Meta Advantage+ architecture. Pure.
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
  selectedIntlStrategyIndex,
  gatewayInsight,
  isNewLaunch,
}: BuildBriefPdfPayloadParams): BriefPDFParams {
  const cp = storeInsights?.products?.find((p) => p.name === productName);
  let productUrl: string | undefined = undefined;
  if (storeInsights?.store?.domain && cp?.handle) {
    productUrl = `https://${storeInsights.store.domain}/products/${cp.handle}`;
  }

  const monthlyOrders =
    storeInsights?.orders?.orders_last_30_days ??
    storeInsights?.orders?.order_count ??
    0;
  const autoGuidance = getAdvantagePlusGuidance(monthlyOrders);

  const advantage_plus_guidance: AdvantagePlusGuidance =
    aiInsights?.advantage_plus_guidance ?? {
      campaign_type: autoGuidance.campaign_type,
      optimization_event: autoGuidance.optimization_event,
      optimization_reasoning:
        aiInsights?.budget?.optimization_event?.reasoning ||
        autoGuidance.default_reasoning,
      seed_audience_suggestions: {
        age_min: aiInsights?.targeting?.age_min ?? 25,
        age_max: aiInsights?.targeting?.age_max ?? 44,
        gender:
          aiInsights?.targeting?.gender === "female" ||
          aiInsights?.targeting?.gender === "Women"
            ? "Women"
            : aiInsights?.targeting?.gender === "male" ||
              aiInsights?.targeting?.gender === "Men"
            ? "Men"
            : "All",
        demographic_justification:
          aiInsights?.targeting?.age_reasoning ||
          "Targeting broad age and gender gives Meta's Advantage+ algorithm maximum flexibility.",
        seed_interests: aiInsights?.targeting?.interests ?? [
          "Online Shopping",
          "Fashion",
        ],
      },
    };

  const defaultBrand = brandName || "our collection";
  const creative_hooks: CreativeHook[] =
    aiInsights?.creative_hooks && aiInsights.creative_hooks.length > 0
      ? aiInsights.creative_hooks
      : [
          {
            angle: "Problem / Friction",
            visual_cue:
              "Close-up demonstration showing common frustration resolved by product",
            on_screen_text: "Stop settling for ordinary.",
            primary_text_hook: `Tired of standard options that don't hold up? Here is what makes ${defaultBrand} different.`,
          },
          {
            angle: "Identity / Status",
            visual_cue:
              "Lifestyle shot showing product in a natural, elevated everyday setting",
            on_screen_text: "Engineered for daily wear.",
            primary_text_hook: `Designed for people who appreciate thoughtful details and timeless style.`,
          },
          {
            angle: "Material / Craftsmanship",
            visual_cue:
              "Macro detail shot highlighting texture, stitching, and finish quality",
            on_screen_text: "Built with premium craft.",
            primary_text_hook: `Every piece is built to feel better and last longer from day one.`,
          },
        ];

  const warnings = (() => {
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
        "Limited product data detected — review seed suggestions before launching.";
      if (!w.includes(warningMsg)) w.push(warningMsg);
    }
    return w;
  })();

  const implementation_steps: ImplementationStep[] = [
    {
      level: "Campaign level",
      title: "Create Campaign & Objective",
      instructions: advantage_plus_guidance.campaign_type.includes("ASC")
        ? "In Meta Ads Manager, click Create, select the Sales objective, and choose Advantage+ Shopping Campaign (ASC) for full automated catalog delivery."
        : "In Meta Ads Manager, click Create, select the Sales objective, and choose Manual Sales Campaign to enable Advantage+ Audience with seed controls.",
    },
    {
      level: "Ad set level",
      title: "Target Audience & Conversion Setup",
      instructions: `Set conversion to Website with optimization event set to ${advantage_plus_guidance.optimization_event}. In Audience controls, enable Advantage+ Audience and set target audience to ${advantage_plus_guidance.seed_audience_suggestions.gender === "All" ? "Men & Women" : advantage_plus_guidance.seed_audience_suggestions.gender} (ages ${advantage_plus_guidance.seed_audience_suggestions.age_min}–${advantage_plus_guidance.seed_audience_suggestions.age_max}) with suggested interest hints.`,
    },
    {
      level: "Ad level",
      title: "Creative Assets & Hook Deployment",
      instructions:
        "Upload creative variations for each of the 3 Creative Hooks. Paste the primary text, headline, and link description, applying the visual cue and on-screen text overlays.",
    },
  ];

  const intlStrategies =
    aiInsights?.budget?.international_strategies ||
    getInternationalStrategies(aiInsights?.budget?.currency || "USD");
  const selectedIntlStrategy =
    intlStrategies[selectedIntlStrategyIndex ?? 1] || intlStrategies[1];
  const intlDaily = selectedIntlStrategy?.daily;
  const intlTier = selectedIntlStrategy?.label;
  const curr = aiInsights?.budget?.currency || "USD";
  const sym = aiInsights?.budget?.currency_symbol;
  const intlBudgetFormatted = intlDaily
    ? `${formatCurrency(intlDaily, curr, sym)}/day`
    : undefined;

  return {
    brandName,
    productName,
    productPrice: cp?.price ? Number(cp.price) : undefined,
    productUrl,
    campaignGoal: goal,
    copy: {
      headline: generatedCopy.headline,
      primaryText: generatedCopy.primaryText,
      description: generatedCopy.description,
      cta: selectedCta || generatedCopy.cta,
      copywriterNote: generatedCopy.copywriterNote,
    },
    creative_hooks,
    advantage_plus_guidance,
    implementation_steps,
    targeting: {
      ...(aiInsights?.targeting ?? {
        locations: [],
        age_min: advantage_plus_guidance.seed_audience_suggestions.age_min,
        age_max: advantage_plus_guidance.seed_audience_suggestions.age_max,
        gender: advantage_plus_guidance.seed_audience_suggestions.gender,
        interests: advantage_plus_guidance.seed_audience_suggestions.seed_interests,
      }),
      international_budget_formatted: intlBudgetFormatted,
    },
    budget: {
      ...(aiInsights?.budget ?? {}),
      recommended_duration_days: selectedDuration,
      recommended_daily:
        aiInsights?.budget?.strategies?.[selectedStrategyIndex]?.daily ??
        aiInsights?.budget?.recommended_daily,
      international_daily: intlDaily,
      international_tier: intlTier,
      international_budget_formatted: intlBudgetFormatted,
      goal_adjusted_daily: aiInsights?.budget
        ? Math.round(
            (aiInsights.budget.strategies?.[selectedStrategyIndex]?.daily ??
              aiInsights.budget.recommended_daily ??
              0) *
              (aiInsights.budget.ad_sets || 1) *
              (aiInsights.budget.breakdown?.goal_multipliers?.[goal] ?? 1)
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
                  aiInsights.budget.currency_symbol
                );
                const newStr = formatCurrency(
                  adjustedPerAdSet,
                  curr,
                  aiInsights.budget.currency_symbol
                );
                res = res.replace(oldStr, newStr);
              }
              if (res) {
                const effectiveIntl =
                  intlBudgetFormatted ||
                  (intlDaily
                    ? `${formatCurrency(intlDaily, curr, aiInsights.budget.currency_symbol)}/day`
                    : "");
                if (effectiveIntl) {
                  res = res.replace(
                    /launch a separate overseas ad set at [^.)]+(?:\([^)]*\))?/gi,
                    `launch a separate overseas ad set at ${effectiveIntl}`
                  );
                }
              }
              return res;
            })()
          : aiInsights?.budget?.reasoning,
    } as BriefPDFParams["budget"],
    timing: (aiInsights?.timing as BriefPDFParams["timing"]) ?? {},
    warnings,
    pre_launch_checklist: {
      out_of_stock_count: 0,
      warnings,
    },
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
  gatewayInsight?: BriefPDFParams["gatewayInsight"] | null;
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
  gatewayInsight,
}: BuildBriefTextParams): string {
  const monthlyOrders =
    storeInsights?.orders?.orders_last_30_days ??
    storeInsights?.orders?.order_count ??
    0;
  const autoGuidance = getAdvantagePlusGuidance(monthlyOrders);
  const guidance = aiInsights?.advantage_plus_guidance ?? {
    campaign_type: autoGuidance.campaign_type,
    optimization_event: autoGuidance.optimization_event,
    optimization_reasoning: autoGuidance.default_reasoning,
    seed_audience_suggestions: {
      age_min: aiInsights?.targeting?.age_min ?? 25,
      age_max: aiInsights?.targeting?.age_max ?? 44,
      gender: (aiInsights?.targeting?.gender as "All" | "Men" | "Women") || "All",
      demographic_justification: "Broad demographic exploration for Advantage+.",
      seed_interests: aiInsights?.targeting?.interests ?? ["Online Shopping"],
    },
  };

  const hooks = aiInsights?.creative_hooks ?? [];

  const hooksSection =
    hooks.length > 0
      ? [
          "── CREATIVE HOOKS (ADVANTAGE+) ──",
          ...hooks.flatMap((h, i) => [
            `Hook ${i + 1} [${h.angle}]:`,
            `  Visual Cue: ${h.visual_cue}`,
            `  On-Screen Text: "${h.on_screen_text}"`,
            `  Opening Hook: "${h.primary_text_hook}"`,
            "",
          ]),
        ]
      : [];

  const isGateway = gatewayInsight?.currentProductClassification === "Gateway";

  return [
    "═══ META ADVANTAGE+ CAMPAIGN BRIEF ═══",
    "",
    ...(isGateway
      ? [
          "PRODUCT ROLE: Gateway Product (Best for acquiring new first-time customers)",
          "",
        ]
      : []),
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
    ...hooksSection,
    "── TARGET AUDIENCE & CAMPAIGN SETTINGS ──",
    `Campaign Type: ${guidance.campaign_type}`,
    `Optimization Event: ${guidance.optimization_event}`,
    `Optimization Strategy: ${guidance.optimization_reasoning}`,
    `Suggested Age: ${guidance.seed_audience_suggestions.age_min} — ${guidance.seed_audience_suggestions.age_max}`,
    `Suggested Gender: ${guidance.seed_audience_suggestions.gender}`,
    `Suggested Interests (AI Starting Hints): ${guidance.seed_audience_suggestions.seed_interests.join(", ")}`,
    aiInsights?.targeting?.locations && aiInsights.targeting.locations.length > 0
      ? `Locations: ${aiInsights.targeting.locations.map((l) => l.name).join(", ")}`
      : "Locations: Set manually in Meta Ads Manager",
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
