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
  generatedAt?: string;
  brandName: string;
  productName: string;
  productPrice?: number;
  goal: string;
  generatedCopy: GeneratedCopy;
  selectedCta: string;
  aiInsights: AiInsights | null;
  storeInsights: StoreInsights | null;
  selectedDuration: number;
  selectedIntlDuration?: number;
  selectedStrategyIndex: number;
  selectedIntlStrategyIndex?: number;
  gatewayInsight: BriefPDFParams["gatewayInsight"] | null;
  isNewLaunch: boolean;
}

/** Keeps the approved test-spend envelope constant when the founder changes
 * the test duration in the brief UI. */
export function rescaleDailyBudgetForDuration(
  daily: number | undefined,
  sourceDuration: number | undefined,
  selectedDuration: number,
): number | undefined {
  if (!daily || daily <= 0) return daily;
  const source = sourceDuration && sourceDuration > 0 ? sourceDuration : 14;
  const selected = selectedDuration > 0 ? selectedDuration : source;
  return Math.max(1, Math.round((daily * source) / selected));
}

/**
 * Strips raw internal errors, GraphQL traces, and developer diagnostics from founder-facing notes.
 */
export function sanitizeUserFacingWarnings(warnings: (string | undefined | null)[]): string[] {
  const technicalRegex = /GraphQL|syntax|unavailable:|argument\s+'sortKey'|shopifyqlQuery|access denied|field\s*\(|failed to fetch|scopes?|HTTP\s+\d+|internal error/i;
  return warnings
    .filter((w): w is string => typeof w === "string" && w.trim().length > 0)
    .filter((msg) => !technicalRegex.test(msg))
    .map((msg) => {
      if (msg.includes("Limited product data detected")) {
        return "New or early catalog piece: We've calibrated broad seed audiences to give Meta the room to explore and find your first buyers.";
      }
      if (msg.includes("guest checkout orders lacked customer IDs")) {
        return "Guest checkout activity: Many shoppers bought as guests, which is normal. Repeat buyer trends are measured from registered customer accounts.";
      }
      if (msg.includes("orders lacked city/region details")) {
        return "Nationwide delivery: Some historical orders only listed the country, so ad delivery is calibrated across your full domestic market.";
      }
      return msg;
    });
}

/**
 * Assembles the full {@link BriefPDFParams} payload sent to the PDF renderer,
 * formatted according to Meta Advantage+ architecture. Pure.
 */
export function buildBriefPdfPayload({
  generatedAt,
  brandName,
  productName,
  productPrice: propProductPrice,
  goal,
  generatedCopy,
  selectedCta,
  aiInsights,
  storeInsights,
  selectedDuration,
  selectedIntlDuration,
  selectedStrategyIndex,
  selectedIntlStrategyIndex,
  gatewayInsight,
  isNewLaunch,
}: BuildBriefPdfPayloadParams): BriefPDFParams {
  const cp = storeInsights?.products?.find((p) => p.name === productName);
  const finalProductPrice =
    propProductPrice !== undefined
      ? propProductPrice
      : cp?.price
      ? Number(cp.price)
      : undefined;
  let productUrl: string | undefined = undefined;
  if (storeInsights?.store?.domain && cp?.handle) {
    productUrl = `https://${storeInsights.store.domain}/products/${cp.handle}`;
  }

  const monthlyOrders =
    storeInsights?.orders?.orders_last_30_days ?? 0;
  const autoGuidance = getAdvantagePlusGuidance(monthlyOrders, storeInsights?.prespend?.analytics?.recent_funnel);

  const advantage_plus_guidance: AdvantagePlusGuidance = {
    campaign_type: autoGuidance.campaign_type,
    optimization_event: autoGuidance.optimization_event,
    optimization_reasoning: autoGuidance.default_reasoning,
    event_evidence: autoGuidance.event_evidence,
    seed_audience_suggestions: aiInsights?.advantage_plus_guidance?.seed_audience_suggestions ?? {
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
          "Targeting broad age and gender gives Meta the flexibility to find your best buyers across your whole audience.",
        seed_interests: aiInsights?.targeting?.interests ?? [
          "Online Shopping",
          "Fashion",
        ],
    },
  };

  const creative_hooks: CreativeHook[] =
    aiInsights?.creative_hooks && aiInsights.creative_hooks.length > 0
      ? aiInsights.creative_hooks
      : [];

  const warnings = (() => {
    const cp = storeInsights?.products?.find((p) => p.name === productName);
    const descLength = cp?.description?.trim().length ?? 0;
    const tagCount = cp?.tags?.length ?? 0;
    const orderCount = cp?.order_count ?? cp?.units_sold ?? 0;
    const storeOrderCount =
      storeInsights?.orders?.order_count ??
      storeInsights?.orders?.orders_last_30_days ??
      0;
    const rawWarnings = [
      ...(aiInsights?.warnings ?? []),
      ...(storeInsights?.data_quality?.warnings ?? []),
    ];
    const w = sanitizeUserFacingWarnings([...new Set(rawWarnings)]);
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

  const seedSuggestions = advantage_plus_guidance?.seed_audience_suggestions || {
    age_min: aiInsights?.targeting?.age_min ?? 25,
    age_max: aiInsights?.targeting?.age_max ?? 44,
    gender: "All" as const,
    demographic_justification:
      aiInsights?.targeting?.age_reasoning ||
      "Targeting broad age and gender gives Meta the flexibility to find your best buyers across your whole audience.",
    seed_interests: aiInsights?.targeting?.interests ?? [
      "Online Shopping",
      "Fashion",
    ],
  };

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
      instructions: `Before publishing, confirm that Purchase is active and receiving recent website events in Meta Events Manager. If verified, set Website conversion to Purchase. In Audience controls, enable Advantage+ Audience and set target audience to ${seedSuggestions.gender === "All" ? "Men & Women" : seedSuggestions.gender} (ages ${seedSuggestions.age_min}–${seedSuggestions.age_max}) with suggested interest hints.`,
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
  const sourceDuration = aiInsights?.budget?.recommended_duration_days ?? 14;
  const selectedStrategyDaily =
    aiInsights?.budget?.strategies?.[selectedStrategyIndex]?.daily ??
    aiInsights?.budget?.recommended_daily;

  return {
    brandName,
    storeCountry: storeInsights?.store?.country,
    productName,
    productPrice: finalProductPrice,
    productUrl,
    campaignGoal: goal,
    copy: {
      headline: generatedCopy.headline,
      primaryText: generatedCopy.primaryText,
      description: generatedCopy.description,
      cta: selectedCta || generatedCopy.cta,
      copywriterNote:
        generatedCopy.copywriterNote ||
        "Written to catch shoppers' attention in their feed, highlight the real product details, and encourage them to visit your store and buy.",
    },
    creative_hooks,
    advantage_plus_guidance,
    implementation_steps,
    targeting: {
      ...(aiInsights?.targeting ?? {
        locations: [],
        age_min: seedSuggestions.age_min,
        age_max: seedSuggestions.age_max,
        gender: seedSuggestions.gender,
        interests: seedSuggestions.seed_interests,
      }),
      international_budget_formatted: intlBudgetFormatted,
    },
    budget: {
      ...(aiInsights?.budget ?? {}),
      recommended_duration_days: selectedDuration,
      international_duration_days: selectedIntlDuration ?? selectedDuration,
      recommended_daily: selectedStrategyDaily,
      calculation: aiInsights?.budget?.calculation
        ? {
            ...aiInsights.budget.calculation,
            baseline_duration_days: selectedDuration,
            baseline_daily: aiInsights.budget.calculation.baseline_daily,
          }
        : undefined,
      international_daily: intlDaily,
      international_tier: intlTier,
      international_budget_formatted: intlBudgetFormatted,
      goal_adjusted_daily: aiInsights?.budget
        ? Math.round(
            (selectedStrategyDaily ?? 0) *
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
        aiInsights?.budget
          ? (() => {
              const strategies = aiInsights.budget.strategies || [];
              const currentStrategy =
                strategies[selectedStrategyIndex] ||
                strategies[1] ||
                strategies[0] ||
                { daily: aiInsights.budget.recommended_daily || 0, label: "Sweet Spot" };
              const baseDaily = currentStrategy.daily || 0;
              const goalMult =
                aiInsights.budget.breakdown?.goal_multipliers?.[goal] ?? 1;
              const adjustedPerAdSet = Math.round(baseDaily * goalMult);
              const originalDaily = aiInsights.budget.recommended_daily;
              const curr = aiInsights.budget.currency || "USD";
              const sym = aiInsights.budget.currency_symbol;
              let res = aiInsights.budget.reasoning;
              if (originalDaily && originalDaily !== adjustedPerAdSet) {
                const oldStr = formatCurrency(
                  originalDaily,
                  curr,
                  sym
                );
                const newStr = formatCurrency(
                  adjustedPerAdSet,
                  curr,
                  sym
                );
                res = res.replace(oldStr, newStr);
              }
              if (res) {
                if (finalProductPrice && finalProductPrice > 0) {
                  const formattedProductPrice = formatCurrency(Math.round(finalProductPrice), curr, sym);
                  res = res.replace(
                    /Calibrated for your product's [^ ]+ price point:/i,
                    `Calibrated for your product's ${formattedProductPrice} price point:`
                  );
                }
                const rawIntlLocs = (
                  aiInsights.targeting?.international_locations && aiInsights.targeting.international_locations.length > 0
                    ? aiInsights.targeting.international_locations
                    : aiInsights.targeting?.locations || []
                );
                if (rawIntlLocs.length > 0) {
                  const displayedIntlCityNames = rawIntlLocs
                    .map((l) => (l.name || l.city || "").split(",")[0].trim())
                    .filter(Boolean)
                    .slice(0, 4)
                    .join(" · ");
                  if (displayedIntlCityNames) {
                    res = res.replace(
                      /Should you ever wish to (?:explore international demand|test overseas sales) in [^,]+,/i,
                      `Should you ever wish to test overseas sales in ${displayedIntlCityNames},`
                    );
                  }
                }
                const effectiveIntl =
                  intlBudgetFormatted ||
                  (intlDaily
                    ? `${formatCurrency(intlDaily, curr, sym)}/day`
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
    timing: {
      ...((aiInsights?.timing as BriefPDFParams["timing"]) ?? {}),
      peak_days:
        aiInsights?.timing?.peak_days && aiInsights.timing.peak_days.length > 0
          ? aiInsights.timing.peak_days
          : storeInsights?.orders?.peak_days && storeInsights.orders.peak_days.length > 0
          ? storeInsights.orders.peak_days
          : undefined,
    } as BriefPDFParams["timing"],
    warnings,
    pre_launch_checklist: {
      out_of_stock_count: storeInsights?.products?.filter((p) => p.in_stock === false).length ?? 0,
      warnings,
    },
    decisionEvidence: {
      analytics_window_days: storeInsights?.prespend?.analytics?.window_days,
      recent_funnel: storeInsights?.prespend?.analytics?.recent_funnel,
      historical_conversion_rate:
        storeInsights?.prespend?.analytics?.conversion_rate,
      unit_cost: cp?.unit_cost,
      unit_cost_coverage: cp?.unit_cost_coverage,
      price_less_unit_cost: cp?.price_less_unit_cost,
    },
    generatedAt: new Date(generatedAt || Date.now()).toLocaleDateString("en-GB", {
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
  selectedIntlStrategyIndex?: number;
  selectedDuration: number;
  selectedIntlDuration?: number;
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
  selectedIntlStrategyIndex,
  selectedDuration,
  selectedIntlDuration,
  gatewayInsight,
}: BuildBriefTextParams): string {
  const monthlyOrders =
    storeInsights?.orders?.orders_last_30_days ?? 0;
  const autoGuidance = getAdvantagePlusGuidance(monthlyOrders, storeInsights?.prespend?.analytics?.recent_funnel);
  const guidance = {
    campaign_type: autoGuidance.campaign_type,
    optimization_event: autoGuidance.optimization_event,
    optimization_reasoning: autoGuidance.default_reasoning,
    event_evidence: autoGuidance.event_evidence,
    seed_audience_suggestions: aiInsights?.advantage_plus_guidance?.seed_audience_suggestions ?? {
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
  const productDecision = gatewayInsight?.productDecision;

  const productRoleSection = productDecision
    ? (() => {
        const roleLabel =
          productDecision.role === "Gateway"
            ? "Gateway Product"
            : productDecision.role === "Consideration"
              ? "Repeat Favorite"
              : productDecision.role === "Hybrid"
                ? "Proven Seller"
                : productDecision.role;

        const roleExplanation =
          productDecision.role === "Gateway"
            ? `${productDecision.first_order_count} new customers picked this as their first purchase—your top product to attract first-time shoppers.`
            : productDecision.role === "Consideration"
              ? `Customers frequently pick this in later orders (${productDecision.later_order_count} repeat orders)—ideal for retargeting.`
              : productDecision.role === "Hybrid"
                ? `Popular with both first-time (${productDecision.first_order_count}) and returning customers (${productDecision.later_order_count}).`
                : productDecision.role_reason;

        const readinessLabel =
          productDecision.test_readiness === "planning_candidate"
            ? "Ready to test (In stock with recorded unit economics)"
            : productDecision.test_readiness === "review"
              ? "Check stock & margins before setting ad budget"
              : "Out of stock (Restock before launching ads)";

        const followUpLabel =
          productDecision.follow_up_60d.repeat_rate === null
            ? "Recent customer cohort maturing (60-day window in progress)"
            : `${productDecision.follow_up_60d.buyers_with_another_order} of ${productDecision.follow_up_60d.eligible_first_order_buyers} buyers (${Math.round(productDecision.follow_up_60d.repeat_rate * 100)}%) returned to order again within 60 days.`;

        return [
          `PRODUCT ROLE: ${roleLabel} — ${roleExplanation}`,
          `TEST READINESS: ${readinessLabel}`,
          `60-DAY LTV FOLLOW-UP: ${followUpLabel}`,
          "",
        ];
      })()
    : isGateway
      ? [
          "PRODUCT ROLE: Gateway Product — Top choice for winning first-time customer orders",
          "",
        ]
      : [];

  return [
    "═══ META ADVANTAGE+ CAMPAIGN BRIEF ═══",
    "",
    ...productRoleSection,
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
    `Suggested Age: ${guidance.seed_audience_suggestions?.age_min ?? 25} — ${guidance.seed_audience_suggestions?.age_max ?? 44}`,
    `Suggested Gender: ${guidance.seed_audience_suggestions?.gender ?? "All"}`,
    `Suggested Interests (AI Starting Hints): ${(guidance.seed_audience_suggestions?.seed_interests ?? ["Online Shopping"]).join(", ")}`,
    aiInsights?.targeting?.locations && aiInsights.targeting.locations.length > 0
      ? `Locations: ${aiInsights.targeting.locations.map((l) => l.name || l.city || "").filter(Boolean).join(", ") || "Set manually in Meta Ads Manager"}`
      : "Locations: Set manually in Meta Ads Manager",
    "",
    "── BUDGET ──",
    aiInsights?.budget
      ? (() => {
          const strategies = aiInsights.budget.strategies || [];
          const currentS =
            strategies[selectedStrategyIndex] ||
            strategies[1] ||
            strategies[0] ||
            { daily: aiInsights.budget.recommended_daily || 0, label: "Sweet Spot" };
          const adSets = aiInsights.budget.ad_sets || 1;
          const gm = aiInsights.budget.breakdown?.goal_multipliers?.[goal] ?? 1;
          const adjustedBase = currentS.daily || 0;
          const adj = Math.round(adjustedBase * adSets * gm);
          const curr = aiInsights.budget.currency || "USD";
          const sym = aiInsights.budget.currency_symbol;

          const intlStrategies =
            aiInsights.budget.international_strategies ||
            getInternationalStrategies(curr);
          const selectedIntlStrategy =
            intlStrategies[selectedIntlStrategyIndex ?? 1] || intlStrategies[1];
          const intlDaily = selectedIntlStrategy?.daily;

          const intlDuration = selectedIntlDuration ?? selectedDuration;
          const lines = [
            `Strategy: ${currentS.label}`,
            `Ad Sets: ${adSets}`,
            `Recommended Daily: ${formatCurrency(adj, curr, sym)}/day`,
            `Test Duration: ${selectedDuration} days`,
            `Total Test Spend: ${formatCurrency(adj * selectedDuration, curr, sym)}`,
          ];

          if (intlDaily && (selectedIntlStrategyIndex !== undefined || aiInsights.budget.international_recommended_daily)) {
            const combinedDaily = adj + intlDaily;
            const combinedSpend = (adj * selectedDuration) + (intlDaily * intlDuration);
            lines.push(
              "",
              `Optional Overseas Strategy: ${selectedIntlStrategy.label}`,
              `Optional Overseas Daily: ${formatCurrency(intlDaily, curr, sym)}/day`,
              `Optional Overseas Test Duration: ${intlDuration} days`,
              `Optional Overseas Test Spend: ${formatCurrency(intlDaily * intlDuration, curr, sym)} (1 separate ad set)`,
              `Combined Total Daily: ${formatCurrency(combinedDaily, curr, sym)}/day`,
              `Combined Total Test Spend: ${formatCurrency(combinedSpend, curr, sym)} (${selectedDuration === intlDuration ? `${selectedDuration} days` : `Local ${selectedDuration}d + Overseas ${intlDuration}d`})`
            );
          }

          lines.push(`Meta Context: ${aiInsights.budget.reasoning}`);
          return lines.filter(Boolean).join("\n");
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
