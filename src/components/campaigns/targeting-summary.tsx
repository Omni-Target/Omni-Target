import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Sparkles, Zap, Target } from "lucide-react";
import type { AiInsights, StoreInsights } from "./types";
import { isDomesticCity, getInternationalBudgetFloor, getEffectiveStoreCountry, getInternationalStrategies, isTier1Market } from "@/lib/market-geography";
import { formatCurrency } from "@/lib/currency";

export function TargetingSummary({
  storeInsights,
  aiInsights,
  loadingAiInsights,
  selectedIntlStrategyIndex,
}: {
  storeInsights: StoreInsights | null;
  aiInsights: AiInsights | null;
  loadingAiInsights: boolean;
  selectedIntlStrategyIndex?: number;
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
    if (l?.market_type === "domestic") return true;
    if (l?.market_type === "international") return false;
    return isDomesticCity(
      l?.name || l?.city || "",
      l?.country,
      effectiveStoreCountry,
      storeCurrency,
      topOrderLocs
    );
  };

  const rawDomestic =
    legacyTargeting?.domestic_locations && legacyTargeting.domestic_locations.length > 0
      ? legacyTargeting.domestic_locations
      : rawLocations.filter(isDomLoc);

  const rawIntl =
    legacyTargeting?.international_locations && legacyTargeting.international_locations.length > 0
      ? legacyTargeting.international_locations
      : rawLocations.filter((l) => !isDomLoc(l));

  const domesticLocs =
    rawDomestic.length > 0
      ? rawDomestic
      : topOrderLocs.filter((l) =>
          isDomesticCity(l.city || "", l.country, effectiveStoreCountry, storeCurrency, topOrderLocs)
        );

  const domesticLocationText = (() => {
    if (isTier1 && isUS) {
      const cities = domesticLocs
        .map((l) => (l?.name || l?.city || "").split(",")[0].trim())
        .filter((c) => Boolean(c) && !c.toLowerCase().includes("united states"));
      if (cities.length > 0) {
        return `United States (Nationwide) · Top buyer hubs: ${cities.slice(0, 5).join(", ")}`;
      }
      return "United States (Nationwide)";
    }
    return domesticLocs.length > 0
      ? domesticLocs
          .map((l) => (l?.name || l?.city || "").split(",")[0].trim())
          .filter(Boolean)
          .join(" · ")
      : "No domestic order data yet — add locations manually based on your target market";
  })();

  const hasOverseasOrders = topOrderLocs.some(
    (l) => !isDomesticCity(l.city || "", l.country, effectiveStoreCountry, storeCurrency, topOrderLocs)
  );

  // For Tier-1 stores (US, UK, etc.), do not invent international campaigns if 0 overseas orders exist.
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

  const domesticBudgetFormatted =
    legacyTargeting?.domestic_budget_formatted ||
    (aiInsights?.budget?.recommended_daily
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
    "AddToCart";
  const optimizationReasoning =
    guidance?.optimization_reasoning ??
    aiInsights?.budget?.optimization_event?.reasoning ??
    "Selected to provide sufficient event frequency for Meta to learn and exit the learning phase.";

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
            {optimizationEvent === "AddToCart" && (
              <div className="mt-2.5 rounded-lg border border-amber-200/80 bg-amber-50/90 p-2.5 text-[11px] leading-relaxed text-amber-900">
                <span className="font-semibold text-amber-950">💡 Quality Check (Cart-to-Purchase Ratio):</span>{" "}
                AddToCart optimization builds pixel learning quickly, but monitor your conversion ratio. If you see over 20 cart adds without a single completed purchase (&lt;5% conversion), check your checkout flow for unexpected shipping costs or payment drops, and consider shifting your optimization event to <strong>InitiateCheckout</strong> or <strong>Purchase</strong>.
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Field
              label={isTier1 && isUS ? "Suggested locations (Advantage+ Audience)" : "Suggested locations (Local)"}
              value={domesticLocationText}
            />
            {domesticBudgetFormatted && (
              <p className="text-[11px] text-muted-foreground font-medium">
                <span className="text-foreground font-semibold">Daily budget:</span> {domesticBudgetFormatted} — {isTier1 && isUS ? "run as 1 ad set for maximum Meta audience liquidity" : "run as 1 ad set to keep your local spend focused"}
              </p>
            )}
          </div>

          {intlLocationText && (
            <div className="rounded-xl bg-indigo-50/70 p-3.5 text-xs text-indigo-950 border border-indigo-100/80 space-y-1.5">
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
              <p className="font-semibold text-foreground text-sm">
                {intlLocationText}
              </p>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {isTier1
                  ? "You do not need to run this now. Should you choose to explore overseas buyers, run them as a separate campaign with its own budget so differing shipping rates, fulfillment times, and regional conversion rates don't distort your domestic ad delivery."
                  : "You do not need to run this now. Should you ever choose to explore overseas buyers, run them as a separate campaign with its own budget so higher foreign ad costs never drain your local money."}
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Suggested age"
              value={
                loadingAiInsights
                  ? "Analyzing…"
                  : `${ageMin} — ${ageMax}`
              }
              hint={demographicJustification}
            />
            <Field
              label="Suggested gender"
              value={loadingAiInsights ? "Analyzing…" : gender}
              capitalize
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <Label>Suggested interests (AI starting hints)</Label>
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
                  Connect your Shopify store for AI-inferred suggested interests
                </span>
              )}
            </div>
            <p className="mt-2 text-[11px] text-subtle-foreground">
              <Sparkles className="mr-1 inline size-3 text-brand-600" />
              Meta uses these suggestions to kickstart audience discovery. As
              soon as the algorithm identifies your buyers, delivery expands
              automatically.
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
