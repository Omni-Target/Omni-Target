import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Sparkles, Zap, Target } from "lucide-react";
import type { AiInsights, StoreInsights } from "./types";
import { isDomesticCity, getInternationalBudgetFloor, getEffectiveStoreCountry, getInternationalStrategies, isTier1Market } from "@/lib/market-geography";
import { formatCurrency } from "@/lib/currency";

type DisplayLocation = {
  name?: string;
  city?: string;
  country?: string;
  market_type?: string;
  source?: string;
};

export function TargetingSummary({
  storeInsights,
  aiInsights,
  loadingAiInsights,
  selectedStrategyIndex,
  selectedIntlStrategyIndex,
  goal,
}: {
  storeInsights: StoreInsights | null;
  aiInsights: AiInsights | null;
  loadingAiInsights: boolean;
  selectedStrategyIndex?: number;
  selectedIntlStrategyIndex?: number;
  goal?: string;
}) {
  const guidance = aiInsights?.advantage_plus_guidance;
  const seed = guidance?.seed_audience_suggestions;
  const legacyTargeting = aiInsights?.targeting;

  const ageMin = seed?.age_min ?? legacyTargeting?.age_min ?? 25;
  const ageMax = seed?.age_max ?? legacyTargeting?.age_max ?? 44;
  const gender = seed?.gender ?? legacyTargeting?.gender ?? "All";
  const demographicJustification =
    seed?.demographic_justification ?? legacyTargeting?.age_reasoning;

  const seedInterests =
    seed?.seed_interests ?? legacyTargeting?.interests ?? [];
  const analytics = storeInsights?.prespend?.analytics;
  const recentFunnel = analytics?.recent_funnel;

  const topOrderLocs = storeInsights?.orders?.top_locations || [];
  const effectiveStoreCountry = getEffectiveStoreCountry(
    storeInsights?.store?.country,
    storeInsights?.store?.currency || aiInsights?.budget?.currency,
    topOrderLocs
  );
  const storeCurrency = storeInsights?.store?.currency || aiInsights?.budget?.currency;
  const isTier1 = isTier1Market(effectiveStoreCountry, storeCurrency);
  const isUS = effectiveStoreCountry.toLowerCase().includes("united states");

  const rawLocations = legacyTargeting?.locations ?? [];

  const isDomLoc = (l: { name?: string; city?: string; country?: string; market_type?: string }) => {
    if (l?.market_type === "international") return false;
    return isDomesticCity(
      l?.name || l?.city || "",
      l?.country,
      effectiveStoreCountry,
      storeCurrency,
      topOrderLocs
    );
  };

  const rawDomestic = (
    legacyTargeting?.domestic_locations && legacyTargeting.domestic_locations.length > 0
      ? legacyTargeting.domestic_locations
      : rawLocations
  ).filter(isDomLoc);

  const rawIntl = (
    legacyTargeting?.international_locations && legacyTargeting.international_locations.length > 0
      ? legacyTargeting.international_locations
      : rawLocations
  ).filter((l) => !isDomLoc(l));

  const domesticLocs =
    rawDomestic.length > 0
      ? rawDomestic
      : topOrderLocs.filter((l) =>
          isDomesticCity(l.city || "", l.country, effectiveStoreCountry, storeCurrency, topOrderLocs)
        );

  const isProvenDom = (l: DisplayLocation) =>
    l?.source === "from_data" ||
    topOrderLocs.some(
      (t) =>
        t.city &&
        t.city.toLowerCase().trim() ===
          (l?.name || l?.city || "").split(",")[0].toLowerCase().trim()
    );

  const provenDomesticLocs = domesticLocs.filter(isProvenDom);
  const recommendedDomesticLocs = domesticLocs.filter((l) => !isProvenDom(l));

  const hasOverseasOrders = topOrderLocs.some(
    (l) => !isDomesticCity(l.city || "", l.country, effectiveStoreCountry, storeCurrency, topOrderLocs)
  );

  const intlLocs =
    isTier1 && !hasOverseasOrders
      ? []
      : rawIntl.length > 0
      ? rawIntl
      : (legacyTargeting?.overseas_demand || [])
          .filter(
            (name) =>
              !isDomesticCity(name, undefined, effectiveStoreCountry, storeCurrency, topOrderLocs)
          )
          .map((name) => ({ name, source: "from_data" as const }));

  const provenIntlLocs = intlLocs.filter(
    (l: DisplayLocation) => l?.source === "from_data"
  );
  const recommendedIntlLocs = intlLocs.filter(
    (l: DisplayLocation) => l?.source !== "from_data"
  );

  const intlLocationText =
    isTier1 && !hasOverseasOrders
      ? ""
      : intlLocs.length > 0
      ? intlLocs
          .map((l: { name?: string; city?: string }) => (l?.name || l?.city || "").split(",")[0].trim())
          .filter(Boolean)
          .join(" · ")
      : topOrderLocs
          .filter((l) => !isDomesticCity(l.city || "", l.country, effectiveStoreCountry, storeCurrency, topOrderLocs))
          .map((l) => l.city)
          .filter(Boolean)
          .join(" · ");

  const chosenDomesticStrategy =
    aiInsights?.budget?.strategies?.[selectedStrategyIndex ?? 1] ||
    aiInsights?.budget?.strategies?.[1];
  const domesticBaseDaily =
    chosenDomesticStrategy?.daily ?? aiInsights?.budget?.recommended_daily;
  const domesticGoalMult =
    goal && aiInsights?.budget?.breakdown?.goal_multipliers?.[goal]
      ? aiInsights.budget.breakdown.goal_multipliers[goal]
      : 1;
  const domesticAdjustedDaily = domesticBaseDaily
    ? Math.round(domesticBaseDaily * domesticGoalMult)
    : undefined;

  const domesticBudgetFormatted =
    legacyTargeting?.domestic_budget_formatted ||
    (domesticAdjustedDaily
      ? `${formatCurrency(domesticAdjustedDaily, storeCurrency || "USD", storeInsights?.store?.currency_symbol || aiInsights?.budget?.currency_symbol)}/day (${chosenDomesticStrategy?.label || "Sweet Spot"})`
      : aiInsights?.budget?.recommended_daily
      ? `${aiInsights.budget.recommended_daily.toLocaleString()} ${storeCurrency || ""}/day`
      : undefined);

  const intlStrategies =
    aiInsights?.budget?.international_strategies ||
    getInternationalStrategies(
      storeCurrency || "USD",
      undefined,
      aiInsights?.budget?.recommended_daily
    );
  const chosenIntlStrategy =
    intlStrategies[selectedIntlStrategyIndex ?? 1] || intlStrategies[1];

  const intlBudgetFormatted =
    chosenIntlStrategy?.daily
      ? `${formatCurrency(chosenIntlStrategy.daily, storeCurrency || "USD", storeInsights?.store?.currency_symbol || aiInsights?.budget?.currency_symbol)}/day (${chosenIntlStrategy.label})`
      : (legacyTargeting?.international_budget_formatted || getInternationalBudgetFloor(storeCurrency || "USD"));

  const campaignType =
    guidance?.campaign_type ??
    "Manual Sales with Advantage+ Audience";
  const optimizationEvent =
    guidance?.optimization_event ??
    aiInsights?.budget?.optimization_event?.event ??
    "Purchase";
  const optimizationReasoning =
    guidance?.optimization_reasoning ??
    aiInsights?.budget?.optimization_event?.reasoning ??
    "Purchase is a sales-goal hypothesis. Confirm that the website event is active in Meta Events Manager before publishing.";

  return (
    <Card className="p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid size-6 place-items-center rounded-md bg-brand-50 text-brand-600">
            <Target className="size-3.5" />
          </span>
          <h3 className="text-sm font-semibold uppercase tracking-widest text-subtle-foreground">
            Target audience &amp; campaign settings
          </h3>
        </div>
        <Badge variant="brand" size="sm">
          {campaignType}
        </Badge>
      </div>

      {storeInsights ? (
        <div className="space-y-5">
          {/* Optimization event callout */}
          <div className="flex flex-col justify-center rounded-xl border border-brand-100 bg-brand-50/60 p-3.5">
            <span className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-brand-600/80">
              Optimize For
            </span>
            <p className="mb-1 flex items-center gap-1.5 text-sm font-bold text-foreground">
              <Zap className="size-3.5 text-brand-600" />
              {optimizationEvent}
            </p>
            <p className="text-[11px] leading-snug text-brand-700/80">
              {optimizationReasoning}
            </p>
            <p className="mt-2 text-[11px] font-medium text-amber-900">
              Meta event status is unverified. Confirm the selected website event in Events Manager before publishing.
            </p>
            {recentFunnel && recentFunnel.cart_sessions !== null && recentFunnel.checkout_sessions !== null && recentFunnel.completed_checkout_sessions !== null && (
              <p className="mt-2 text-[11px] text-brand-700/80">
                Shopify, last {recentFunnel.window_days} days: {recentFunnel.cart_sessions} cart sessions · {recentFunnel.checkout_sessions} checkout sessions · {recentFunnel.completed_checkout_sessions} completed-checkout sessions. These are not Meta events.
              </p>
            )}
            {optimizationEvent === "AddToCart" && (
              <div className="mt-2.5 rounded-lg border border-amber-200/80 bg-amber-50/90 p-2.5 text-[11px] leading-relaxed text-amber-900">
                <span className="font-semibold text-amber-950">Quality check:</span>{" "}
                Cart additions are early intent, not completed purchases. Compare observed cart, checkout and purchase outcomes; check delivery fees, mobile payments, sizing clarity and return-policy terms before changing the event.
              </div>
            )}
          </div>

          <div className="space-y-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-faint-foreground block">
              {isTier1 && isUS ? "Suggested locations (Advantage+ Audience)" : "Suggested locations (Local Market)"}
            </span>

            {isTier1 && isUS && (
              <div className="mb-2">
                <span className="inline-flex items-center rounded-md bg-emerald-50 border border-emerald-200/60 px-2.5 py-1 text-xs font-bold text-emerald-800">
                  United States (Nationwide)
                </span>
              </div>
            )}

            {provenDomesticLocs.length > 0 && recommendedDomesticLocs.length > 0 ? (
              <div className="space-y-3 rounded-xl border border-border bg-surface-subtle p-3.5">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-800 block mb-1">
                    ✓ Proven by past store orders
                  </span>
                  <p className="font-semibold text-foreground text-sm">
                    {provenDomesticLocs
                      .map((l: DisplayLocation) => (l?.name || l?.city || "").split(",")[0].trim())
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <p className="text-[11px] font-medium text-emerald-700 mt-0.5">
                    Based on past customer shipments in your Shopify store.
                  </p>
                </div>

                <div className="pt-2 border-t border-border">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
                    💡 Suggested regional hubs (AI hypothesis)
                  </span>
                  <p className="font-semibold text-foreground text-sm">
                    {recommendedDomesticLocs
                      .map((l: DisplayLocation) => (l?.name || l?.city || "").split(",")[0].trim())
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                    Major commercial centers to test based on regional purchasing power and style affinity. A suggested starting hypothesis to test alongside your proven customer locations.
                  </p>
                </div>
              </div>
            ) : provenDomesticLocs.length > 0 ? (
              <div className="rounded-xl border border-border bg-surface-subtle p-3.5 space-y-1">
                <p className="font-semibold text-foreground text-sm">
                  {provenDomesticLocs
                    .map((l: DisplayLocation) => (l?.name || l?.city || "").split(",")[0].trim())
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <p className="text-[11px] font-medium text-emerald-700 flex items-center gap-1">
                  <span>✓</span> <span><strong>Proven by past store orders:</strong> Sourced from customer shipping orders in your Shopify store.</span>
                </p>
              </div>
            ) : recommendedDomesticLocs.length > 0 ? (
              <div className="rounded-xl border border-border bg-surface-subtle p-3.5 space-y-1">
                <p className="font-semibold text-foreground text-sm">
                  {recommendedDomesticLocs
                    .map((l: DisplayLocation) => (l?.name || l?.city || "").split(",")[0].trim())
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <p className="text-[11px] font-medium text-muted-foreground flex items-center gap-1 leading-relaxed">
                  <span>💡</span> <span><strong>Top shopping cities (AI suggested):</strong> Inferred for high conversion — major commercial hubs where shoppers buy online most often.</span>
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No domestic order data yet — add locations manually based on your target market.
              </p>
            )}

            {domesticBudgetFormatted && (
              <p className="text-[11px] text-muted-foreground font-medium pt-1">
                <span className="text-foreground font-semibold">Daily budget:</span> {domesticBudgetFormatted} — {isTier1 && isUS ? "run as 1 ad set to let Meta find buyers without splitting your spend" : "run as 1 ad set to keep your local spend focused"}
              </p>
            )}
          </div>

          {intlLocationText && (
            <div className="rounded-xl bg-indigo-50/70 p-3.5 text-xs text-indigo-950 border border-indigo-100/80 space-y-3">
              <div className="font-semibold flex items-center justify-between text-indigo-700">
                <span className="flex items-center gap-1.5">
                  <span>🌍</span> International locations to consider (Optional)
                </span>
                {intlBudgetFormatted && (
                  <span className="rounded bg-indigo-100 px-2 py-0.5 text-[11px] font-bold text-indigo-800">
                    Optional · {intlBudgetFormatted}
                  </span>
                )}
              </div>

              {provenIntlLocs.length > 0 && recommendedIntlLocs.length > 0 ? (
                <div className="space-y-3">
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-800 block mb-1">
                      ✓ Proven by past store orders
                    </span>
                    <p className="font-semibold text-foreground text-sm">
                      {provenIntlLocs
                        .map((l: DisplayLocation) => (l?.name || l?.city || "").split(",")[0].trim())
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    <p className="text-[11px] font-medium text-emerald-700 mt-1">
                      Based on past customer shipments in your Shopify store.
                    </p>
                  </div>
                  <div className="pt-2 border-t border-indigo-100">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-800 block mb-1">
                      💡 Suggested expansion markets (AI hypothesis)
                    </span>
                    <p className="font-semibold text-foreground text-sm">
                      {recommendedIntlLocs
                        .map((l: DisplayLocation) => (l?.name || l?.city || "").split(",")[0].trim())
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    <p className="text-[11px] font-medium text-indigo-700 mt-1 leading-relaxed">
                      Major international commercial and diaspora centers. You haven&apos;t shipped there yet — win your home market first before testing overseas.
                    </p>
                  </div>
                </div>
              ) : provenIntlLocs.length > 0 ? (
                <div>
                  <p className="font-semibold text-foreground text-sm">
                    {provenIntlLocs
                      .map((l: DisplayLocation) => (l?.name || l?.city || "").split(",")[0].trim())
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <p className="text-[11px] font-medium text-emerald-700 flex items-center gap-1 mt-1">
                    <span>✓</span> <span><strong>Proven by past store orders:</strong> Sourced from past customer shipments in Shopify.</span>
                  </p>
                </div>
              ) : (
                <div>
                  <p className="font-semibold text-foreground text-sm">
                    {recommendedIntlLocs
                      .map((l: DisplayLocation) => (l?.name || l?.city || "").split(",")[0].trim())
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <p className="text-[11px] font-medium text-indigo-700 mt-1 leading-relaxed">
                    <span>💡</span> <span><strong>Suggested expansion markets (AI hypothesis):</strong> Major international commercial and diaspora centers. You haven&apos;t shipped there yet — win your home market first before testing overseas.</span>
                  </p>
                </div>
              )}

              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {isTier1
                  ? "You do not need to run this now. Should you choose to explore overseas buyers, run them as a separate campaign with its own budget so differing shipping rates, fulfillment times, and regional conversion rates don't distort your domestic ad delivery."
                  : "You do not need to run this now. Should you ever choose to explore overseas buyers, run them as a separate campaign with its own budget so higher foreign ad costs never drain your local money."}
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Suggested starting age"
              value={
                loadingAiInsights
                  ? "Analyzing…"
                  : `${ageMin} — ${ageMax}`
              }
              hint={demographicJustification || `Shopify doesn't track customer age. We recommend ${ageMin}–${ageMax} as an informed starting range because shoppers in this bracket have the purchasing power for this price point.`}
            />
            <Field
              label="Suggested gender"
              value={loadingAiInsights ? "Analyzing…" : gender}
              capitalize
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <Label>Suggested interests (Starting hints)</Label>
              <span className="text-[10px] text-muted-foreground">
                Audience suggestions
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {seedInterests.length > 0 ? (
                seedInterests.map((interest, i) => (
                  <Badge key={i} variant="brand">
                    {interest}
                  </Badge>
                ))
              ) : loadingAiInsights ? (
                <span className="text-xs italic text-subtle-foreground">
                  Generating suggested interests from your store catalogue…
                </span>
              ) : (
                <span className="text-xs italic text-subtle-foreground">
                  Connect your Shopify store for suggested interests
                </span>
              )}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-subtle-foreground">
              <Sparkles className="mr-1 inline size-3 text-brand-600" />
              Store-informed suggestions based on your catalog and buyer interests. Enter these under Detailed Targeting in Ads Manager to guide Meta&apos;s Advantage+ audience discovery.
            </p>
          </div>
        </div>
      ) : (
        <Alert variant="brand">
          Connect your Shopify store in Settings for personalised target audience
          and campaign suggestions based on your actual customers.
        </Alert>
      )}
    </Card>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-faint-foreground">
      {children}
    </span>
  );
}

function Field({
  label,
  value,
  hint,
  capitalize,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  capitalize?: boolean;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <p
        className={`mt-1 text-sm text-foreground ${
          capitalize ? "capitalize" : ""
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-subtle-foreground">{hint}</p>}
    </div>
  );
}
