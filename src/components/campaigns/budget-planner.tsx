"use client";

import { useState } from "react";
import { Zap, Info, Globe, MapPin } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/currency";
import {
  getInternationalBudgetFloor,
  getInternationalStrategies,
  isDomesticCity,
  getEffectiveStoreCountry,
  isTier1Market,
} from "@/lib/market-geography";
import type { AiInsights, StoreInsights } from "./types";

const TIMELINES = [
  { days: 7 as const, label: "Creative test" },
  { days: 14 as const, label: "Standard test" },
  { days: 30 as const, label: "Full launch" },
];

export function BudgetPlanner({
  aiInsights,
  storeInsights,
  goal,
  selectedStrategyIndex,
  setSelectedStrategyIndex,
  selectedDuration,
  setSelectedDuration,
  loadingAiInsights,
  selectedIntlStrategyIndex: propSelectedIntlStrategyIndex,
  setSelectedIntlStrategyIndex: propSetSelectedIntlStrategyIndex,
}: {
  aiInsights: AiInsights | null;
  storeInsights?: StoreInsights | null;
  goal: string;
  selectedStrategyIndex: number;
  setSelectedStrategyIndex: (i: number) => void;
  selectedIntlStrategyIndex?: number;
  setSelectedIntlStrategyIndex?: (i: number) => void;
  selectedDuration: 7 | 14 | 30;
  setSelectedDuration: (d: 7 | 14 | 30) => void;
  loadingAiInsights: boolean;
}) {
  const topOrderLocs = storeInsights?.orders?.top_locations || [];
  const effectiveStoreCountry = getEffectiveStoreCountry(
    storeInsights?.store?.country,
    storeInsights?.store?.currency || aiInsights?.budget?.currency,
    topOrderLocs
  );
  const storeCurrency = storeInsights?.store?.currency || aiInsights?.budget?.currency;
  const isTier1 = isTier1Market(effectiveStoreCountry, storeCurrency);
  const isUS = effectiveStoreCountry.toLowerCase().includes("united states");
  const hasOverseasOrders = topOrderLocs.some(
    (l) => !isDomesticCity(l.city || "", l.country, effectiveStoreCountry, storeCurrency, topOrderLocs)
  );
  // Show overseas only if it's an emerging market or if a Tier-1 store has actual overseas order history
  const showOverseas = isTier1 ? hasOverseasOrders : true;

  const [activeMarket, setActiveMarket] = useState<"domestic" | "international">("domestic");
  const [localSelectedIntlStrategyIndex, setLocalSelectedIntlStrategyIndex] = useState(1);
  const selectedIntlStrategyIndex = propSelectedIntlStrategyIndex ?? localSelectedIntlStrategyIndex;
  const setSelectedIntlStrategyIndex = propSetSelectedIntlStrategyIndex ?? setLocalSelectedIntlStrategyIndex;

  const budget = aiInsights?.budget;
  const strategies = budget?.strategies ?? [];
  const hasBudget = !!budget && strategies.length > 0;

  return (
    <Card className="p-6">
      <div className="mb-5 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-widest text-subtle-foreground">
          Budget strategy
        </h3>
        {budget?.tier && (
          <Badge variant="brand" size="sm">
            {budget.tier} tier
          </Badge>
        )}
      </div>

      {hasBudget
        ? (() => {
            const isIntlTab = showOverseas && activeMarket === "international";

            // Local Market calculations
            const localStrategy = strategies[selectedStrategyIndex] || strategies[1];
            const adSets = budget!.ad_sets || 1;
            const goalMult = budget!.breakdown?.goal_multipliers?.[goal] ?? 1;
            const localBaseDaily = localStrategy.daily;
            const localAdjustedDaily = Math.round(localBaseDaily * goalMult);
            const curr = budget!.currency;
            const sym = budget!.currency_symbol;

            // International Market calculations
            const intlStrategies =
              budget!.international_strategies || getInternationalStrategies(curr, undefined, localBaseDaily);
            const intlStrategy = intlStrategies[selectedIntlStrategyIndex] || intlStrategies[1];
            const intlBaseDaily = intlStrategy.daily;
            const intlAdjustedDaily = intlBaseDaily;

            // Active market selection
            const activeStrategies = isIntlTab ? intlStrategies : strategies;
            const activeStrategyIdx = isIntlTab ? selectedIntlStrategyIndex : selectedStrategyIndex;
            const onSelectStrategy = isIntlTab ? setSelectedIntlStrategyIndex : setSelectedStrategyIndex;
            const activeCurrentStrategy = isIntlTab ? intlStrategy : localStrategy;
            const activeAdjustedDaily = isIntlTab ? intlAdjustedDaily : localAdjustedDaily;

            let dynamicBudgetReasoning = budget!.reasoning;
            const originalDaily = budget!.recommended_daily;
            if (originalDaily && originalDaily !== localAdjustedDaily) {
              const oldStr = formatCurrency(originalDaily, curr, sym);
              const newStr = formatCurrency(localAdjustedDaily, curr, sym);
              dynamicBudgetReasoning = dynamicBudgetReasoning.replace(oldStr, newStr);
            }

            return (
              <div className="space-y-6">
                {/* Market Switcher Tabs — only show if international expansion is applicable */}
                {showOverseas && (
                  <div className="flex rounded-xl bg-surface-subtle p-1 border border-border">
                    <button
                      type="button"
                      onClick={() => setActiveMarket("domestic")}
                      className={cn(
                        "flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-bold transition-all cursor-pointer",
                        !isIntlTab
                          ? "bg-surface text-foreground shadow-xs border border-border"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <MapPin className="size-3.5 text-brand-600" />
                      <span>Local Market (Domestic)</span>
                      <span className="hidden sm:inline rounded bg-brand-100 px-1.5 py-0.5 text-[9px] font-bold text-brand-700">
                        Primary (Start Here)
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveMarket("international")}
                      className={cn(
                        "flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-bold transition-all cursor-pointer",
                        isIntlTab
                          ? "bg-surface text-foreground shadow-xs border border-border"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <Globe className="size-3.5 text-indigo-600" />
                      <span>International (Overseas)</span>
                      <span className="hidden sm:inline rounded bg-indigo-50 border border-indigo-200/60 px-1.5 py-0.5 text-[9px] font-bold text-indigo-700">
                        Optional Expansion
                      </span>
                    </button>
                  </div>
                )}

                {/* Helpful reassurance banner when viewing international tab */}
                {isIntlTab && (
                  <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-3.5 text-xs text-indigo-950 flex items-start gap-2.5">
                    <Info className="size-4 text-indigo-600 shrink-0 mt-0.5" />
                    <p className="leading-relaxed">
                      <strong>Optional Overseas Exploration:</strong> You do <strong>not</strong> need to run this alongside your local campaign right now. We provide this calculated estimate so you have the exact numbers ready should you ever decide to test international buyers in the future, without hurting your local cash flow.
                    </p>
                  </div>
                )}

                {/* Strategy toggles */}
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-faint-foreground">
                      {showOverseas
                        ? isIntlTab
                          ? "Optional Overseas Strategy (1 Ad Set)"
                          : "Local Budget Strategy (1 Ad Set)"
                        : isUS
                        ? "Advantage+ Budget Strategy (1 Ad Set)"
                        : "Budget Strategy (1 Ad Set)"}
                    </span>
                    <span className="text-[10px] font-medium text-muted-foreground">
                      {showOverseas && isIntlTab
                        ? "When ready to test foreign buyers"
                        : "Recommended starting foundation"}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {activeStrategies.map((s, idx) => {
                      const sDaily = isIntlTab ? s.daily : Math.round(s.daily * goalMult);
                      const active = activeStrategyIdx === idx;
                      return (
                        <button
                          key={s.label}
                          onClick={() => onSelectStrategy(idx)}
                          className={cn(
                            "relative flex flex-col items-center justify-center rounded-xl border p-3 transition-all cursor-pointer",
                            active
                              ? isIntlTab
                                ? "border-indigo-300 bg-indigo-50 text-foreground"
                                : "border-brand-300 bg-brand-50 text-foreground"
                              : "border-border bg-surface text-muted-foreground hover:border-border-strong",
                          )}
                        >
                          {s.label === "Sweet Spot" && (
                            <span
                              className={cn(
                                "absolute -top-2 whitespace-nowrap rounded-full px-2 py-0.5 text-[8px] font-bold uppercase tracking-wide text-white shadow-sm",
                                isIntlTab ? "bg-indigo-600" : "bg-brand-600"
                              )}
                            >
                              Recommended
                            </span>
                          )}
                          <span className="text-center text-[10px] font-bold uppercase tracking-tight">
                            {s.label}
                          </span>
                          <span className="mt-1 text-xs font-bold text-foreground">
                            {formatCurrency(sDaily, curr, sym)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Timeline toggles */}
                <div>
                  <h4 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-faint-foreground">
                    {isIntlTab ? "Overseas test timeline (if running)" : "Local test timeline"}
                  </h4>
                  <div className="grid grid-cols-3 gap-2">
                    {TIMELINES.map((t) => {
                      const active = selectedDuration === t.days;
                      return (
                        <button
                          key={t.days}
                          onClick={() => setSelectedDuration(t.days)}
                          className={cn(
                            "flex flex-col items-center justify-center rounded-xl border p-3 transition-all cursor-pointer",
                            active
                              ? "border-border-strong bg-surface-muted text-foreground"
                              : "border-border bg-surface text-muted-foreground hover:border-border-strong",
                          )}
                        >
                          <span className="text-center text-[10px] font-bold uppercase tracking-tight">
                            {t.label}
                          </span>
                          <span className="mt-1 text-xs font-bold text-foreground">{t.days} days</span>
                          <span className="mt-0.5 text-[9px] text-subtle-foreground">
                            {formatCurrency(activeAdjustedDaily * t.days, curr, sym)} total
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Tiles */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div
                    className={cn(
                      "flex flex-col justify-center rounded-xl border p-4",
                      isIntlTab
                        ? "border-indigo-100 bg-indigo-50/50"
                        : "border-border bg-surface-subtle"
                    )}
                  >
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-faint-foreground">
                      {isIntlTab ? "Optional overseas daily budget" : "Recommended daily (Local)"}
                    </span>
                    <p className="mt-1 text-xl font-bold text-foreground">
                      {formatCurrency(activeAdjustedDaily, curr, sym)}
                      <span className="text-sm font-normal text-subtle-foreground">/day</span>
                    </p>
                    <p className="mt-1 text-[10px] font-medium text-subtle-foreground">
                      {isIntlTab
                        ? "1 separate ad set (run only when ready)"
                        : `${formatCurrency(localBaseDaily, curr, sym)} × 1 ad set (core market)`}
                    </p>
                    {!isIntlTab && goalMult !== 1 && (
                      <p className="mt-1 text-[10px] font-medium uppercase tracking-tight text-brand-600">
                        {goalMult < 1
                          ? `▼ ${Math.round((1 - goalMult) * 100)}% lower`
                          : `▲ ${Math.round((goalMult - 1) * 100)}% higher`}{" "}
                        for {goal.toLowerCase()}
                      </p>
                    )}
                  </div>

                  {budget!.optimization_event && (
                    <div className="flex flex-col justify-center rounded-xl border border-brand-100 bg-brand-50 p-4">
                      <span className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-brand-600/80">
                        Optimization event
                      </span>
                      <p className="mb-1 flex items-center gap-1.5 text-sm font-bold text-foreground">
                        <Zap className="size-3.5 text-brand-600" />
                        {budget!.optimization_event.event}
                      </p>
                      <p className="text-[10px] leading-snug text-brand-700/80">
                        {budget!.optimization_event.reasoning}
                      </p>
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  {/* Strategy Explanation Callout */}
                  <div className="rounded-xl border border-border bg-surface p-4 shadow-xs">
                    <div className="flex items-start gap-3">
                      <span
                        className={cn(
                          "grid size-7 shrink-0 place-items-center rounded-lg mt-0.5",
                          isIntlTab
                            ? "bg-indigo-100 text-indigo-700"
                            : "bg-brand-100 text-brand-600"
                        )}
                      >
                        <Info className="size-3.5" />
                      </span>
                      <div>
                        <p className="mb-1 text-xs font-bold uppercase tracking-wider text-foreground">
                          {activeCurrentStrategy.label}{" "}
                          {showOverseas && (
                            <span className="text-[10px] font-normal text-muted-foreground">
                              ({isIntlTab ? "Optional Overseas Tier" : "Primary Local Tier"})
                            </span>
                          )}
                        </p>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {activeCurrentStrategy.description}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Campaign Budget Summary */}
                  {showOverseas ? (
                    <div className="rounded-xl border border-border bg-surface p-4 space-y-3 shadow-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold uppercase tracking-wider text-foreground flex items-center gap-1.5">
                          <span>🧭</span> Independent Campaign Budgets
                        </span>
                        <span className="rounded bg-surface-subtle border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          Run Separately, Never Combined
                        </span>
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 pt-1 text-xs">
                        <div className="rounded-lg bg-surface-subtle p-3 border border-brand-200/60 shadow-xs">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-brand-700">
                              1. Primary Market (Local)
                            </span>
                            <span className="rounded bg-brand-100 px-1.5 py-0.5 text-[8px] font-bold uppercase text-brand-700">
                              Start Here
                            </span>
                          </div>
                          <p className="mt-1 text-base font-bold text-foreground">
                            {formatCurrency(localAdjustedDaily, curr, sym)}/day
                          </p>
                          <p className="text-[11px] text-muted-foreground mt-1">
                            Your core campaign. Start here to build consistent sales in your home market before spending on foreign ads.
                          </p>
                        </div>

                        <div className="rounded-lg bg-surface-subtle p-3 border border-indigo-200/60 shadow-xs">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-700">
                              2. Overseas Test (Optional)
                            </span>
                            <span className="rounded bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 text-[8px] font-bold uppercase text-indigo-700">
                              Explore Later
                            </span>
                          </div>
                          <p className="mt-1 text-base font-bold text-indigo-950">
                            {formatCurrency(intlAdjustedDaily, curr, sym)}/day
                          </p>
                          <p className="text-[11px] text-muted-foreground mt-1">
                            Should you ever choose to explore foreign buyers, run this as a separate ad set so overseas CPMs don't drain your local money.
                          </p>
                        </div>
                      </div>

                      <div className="rounded-lg bg-brand-50/60 border border-brand-100 p-2.5 text-[11px] text-brand-900 leading-relaxed">
                        💡 <strong>Founder Guidance:</strong> We show both figures so you have the exact numbers if you ever want to expand abroad. <strong>Do not feel pressured to run both at once.</strong> Starting with your local budget first protects your cash flow and builds early momentum.
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-border bg-surface p-4 space-y-3 shadow-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold uppercase tracking-wider text-foreground flex items-center gap-1.5">
                          <span>🎯</span> {isUS ? "US Advantage+ Campaign Budget" : "Consolidated Campaign Budget"}
                        </span>
                        <span className="rounded bg-brand-50 border border-brand-200 px-2 py-0.5 text-[10px] font-semibold text-brand-700">
                          1 Ad Set · Maximum Liquidity
                        </span>
                      </div>
                      <div className="rounded-lg bg-surface-subtle p-3 border border-brand-200/60 shadow-xs text-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-brand-700">
                            Recommended Daily Spend
                          </span>
                          <span className="rounded bg-brand-100 px-1.5 py-0.5 text-[8px] font-bold uppercase text-brand-700">
                            Start Here
                          </span>
                        </div>
                        <p className="mt-1 text-base font-bold text-foreground">
                          {formatCurrency(localAdjustedDaily, curr, sym)}/day
                        </p>
                        <p className="text-[11px] text-muted-foreground mt-1">
                          Estimated test spend: {formatCurrency(localAdjustedDaily * selectedDuration, curr, sym)} for {selectedDuration} days. Run as 1 consolidated Advantage+ campaign to give Meta maximum algorithmic liquidity and build initial pixel learning.
                        </p>
                      </div>
                      <div className="rounded-lg bg-brand-50/60 border border-brand-100 p-2.5 text-[11px] text-brand-900 leading-relaxed">
                        💡 <strong>Founder Guidance:</strong> Consolidating your budget into a single campaign gives Meta's machine learning the data volume it needs to optimize quickly, without fragmenting your spend across unnecessary ad sets.
                      </div>
                    </div>
                  )}

                  {/* Revenue-based context */}
                  <div className="rounded-xl border border-border bg-surface-subtle p-4">
                    <p className="text-xs italic leading-relaxed text-subtle-foreground">
                      {dynamicBudgetReasoning}
                    </p>
                  </div>
                </div>
              </div>
            );
          })()
        : (
          <Alert variant="brand">
            {loadingAiInsights
              ? "Calculating optimal budget for Meta's learning phase…"
              : "Set your own daily budget directly in Meta Ads Manager."}
          </Alert>
        )}
    </Card>
  );
}
