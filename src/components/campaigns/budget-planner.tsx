"use client";

import { Zap, Info } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/currency";
import type { AiInsights } from "./types";

const TIMELINES = [
  { days: 7 as const, label: "Creative test" },
  { days: 14 as const, label: "Standard test" },
  { days: 30 as const, label: "Full launch" },
];

export function BudgetPlanner({
  aiInsights,
  goal,
  selectedStrategyIndex,
  setSelectedStrategyIndex,
  selectedDuration,
  setSelectedDuration,
  loadingAiInsights,
}: {
  aiInsights: AiInsights | null;
  goal: string;
  selectedStrategyIndex: number;
  setSelectedStrategyIndex: (i: number) => void;
  selectedDuration: 7 | 14 | 30;
  setSelectedDuration: (d: 7 | 14 | 30) => void;
  loadingAiInsights: boolean;
}) {
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
            const currentStrategy = strategies[selectedStrategyIndex] || strategies[1];
            const adSets = budget!.ad_sets || 1;
            const goalMult = budget!.breakdown?.goal_multipliers?.[goal] ?? 1;
            const baseDaily = currentStrategy.daily;
            const adjustedDaily = Math.round(baseDaily * adSets * goalMult);
            const curr = budget!.currency;
            const sym = budget!.currency_symbol;

            let dynamicBudgetReasoning = budget!.reasoning;
            const originalDaily = budget!.recommended_daily;
            const adjustedPerAdSet = Math.round(baseDaily * goalMult);
            if (originalDaily && originalDaily !== adjustedPerAdSet) {
              const oldStr = formatCurrency(originalDaily, curr, sym);
              const newStr = formatCurrency(adjustedPerAdSet, curr, sym);
              dynamicBudgetReasoning = dynamicBudgetReasoning.replace(oldStr, newStr);
            }

            return (
              <div className="space-y-6">
                {/* Strategy toggles */}
                <div className="grid grid-cols-3 gap-2">
                  {strategies.map((s, idx) => {
                    const sAdjustedDaily = Math.round(s.daily * adSets * goalMult);
                    const active = selectedStrategyIndex === idx;
                    return (
                      <button
                        key={s.label}
                        onClick={() => setSelectedStrategyIndex(idx)}
                        className={cn(
                          "relative flex flex-col items-center justify-center rounded-xl border p-3 transition-all",
                          active
                            ? "border-brand-300 bg-brand-50 text-foreground"
                            : "border-border bg-surface text-muted-foreground hover:border-border-strong",
                        )}
                      >
                        {s.label === "Sweet Spot" && (
                          <span className="absolute -top-2 whitespace-nowrap rounded-full bg-brand-600 px-2 py-0.5 text-[8px] font-bold uppercase tracking-wide text-white shadow-sm">
                            Recommended
                          </span>
                        )}
                        <span className="text-center text-[10px] font-bold uppercase tracking-tight">
                          {s.label}
                        </span>
                        <span className="mt-1 text-xs font-bold text-foreground">
                          {formatCurrency(sAdjustedDaily, curr, sym)}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Timeline toggles */}
                <div>
                  <h4 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-faint-foreground">
                    Test timeline
                  </h4>
                  <div className="grid grid-cols-3 gap-2">
                    {TIMELINES.map((t) => {
                      const active = selectedDuration === t.days;
                      return (
                        <button
                          key={t.days}
                          onClick={() => setSelectedDuration(t.days)}
                          className={cn(
                            "flex flex-col items-center justify-center rounded-xl border p-3 transition-all",
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
                            {formatCurrency(adjustedDaily * t.days, curr, sym)} total
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="flex flex-col justify-center rounded-xl border border-border bg-surface-subtle p-4">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-faint-foreground">
                      Recommended daily
                    </span>
                    <p className="mt-1 text-xl font-bold text-foreground">
                      {formatCurrency(adjustedDaily, curr, sym)}
                      <span className="text-sm font-normal text-subtle-foreground">/day</span>
                    </p>
                    <p className="mt-1 text-[10px] font-medium text-subtle-foreground">
                      {formatCurrency(baseDaily, curr, sym)} × {adSets} ad sets
                    </p>
                    {goalMult !== 1 && (
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
                  <div className="rounded-xl border border-brand-100 bg-brand-50 p-4">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 grid size-6 place-items-center rounded-md bg-brand-100 text-brand-600">
                        <Info className="size-3.5" />
                      </span>
                      <div>
                        <p className="mb-1 text-xs font-bold uppercase tracking-wider text-foreground">
                          {currentStrategy.label}
                        </p>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {(() => {
                            let desc = currentStrategy.description;
                            if (goalMult !== 1) {
                              const oldDailyStr = formatCurrency(currentStrategy.daily, curr, sym);
                              const newDailyStr = formatCurrency(Math.round(currentStrategy.daily * goalMult), curr, sym);
                              const oldTotalStr = formatCurrency(currentStrategy.total_daily, curr, sym);
                              const newTotalStr = formatCurrency(Math.round(currentStrategy.total_daily * goalMult), curr, sym);
                              desc = desc.replace(oldDailyStr, newDailyStr);
                              if (oldTotalStr !== oldDailyStr) {
                                desc = desc.replace(oldTotalStr, newTotalStr);
                              }
                            }
                            return desc;
                          })()}
                        </p>
                      </div>
                    </div>
                  </div>

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
