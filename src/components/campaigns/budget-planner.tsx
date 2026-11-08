"use client";

import { useId, useState } from "react";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { budgetPlanFor } from "@/lib/campaigns/brief";
import { BUDGET_TEST_DURATIONS, describeBudgetPlan, normalizeMaxTotalBudget } from "@/lib/budget-plan";
import type { AiInsights, StoreInsights } from "./types";

/**
 * Test budget (Phase S0.6). Omni Target no longer recommends budgets from
 * store-wide revenue; the merchant sets the maximum they are willing to spend
 * on this test and the brief shows only that, split evenly over the test.
 * Wording comes from describeBudgetPlan() so the brief view, PDF and
 * plain-text export always agree.
 */
interface BudgetPlannerProps {
  aiInsights: AiInsights | null;
  storeInsights: StoreInsights | null;
  selectedDuration: 7 | 14 | 30;
  setSelectedDuration: (duration: 7 | 14 | 30) => void;
  maxTestBudget: number | null;
  setMaxTestBudget: (value: number | null) => void;
}

export function BudgetPlanner({
  aiInsights,
  storeInsights,
  selectedDuration,
  setSelectedDuration,
  maxTestBudget,
  setMaxTestBudget,
}: BudgetPlannerProps) {
  const inputId = useId();
  const [draft, setDraft] = useState(maxTestBudget != null ? String(maxTestBudget) : "");
  const [error, setError] = useState<string | null>(null);

  const plan = budgetPlanFor({ aiInsights, storeInsights, maxTestBudget, selectedDuration });
  const text = describeBudgetPlan(plan);

  const commit = () => {
    if (draft.trim() === "") {
      setError(null);
      setMaxTestBudget(null);
      return;
    }
    const parsed = normalizeMaxTotalBudget(draft);
    if (parsed === null) {
      setError("Enter an amount greater than zero.");
      return;
    }
    setError(null);
    setMaxTestBudget(parsed);
  };

  return (
    <Card className="p-6">
      <h3 className="mb-1 text-sm font-semibold uppercase tracking-widest text-subtle-foreground">
        Test budget
      </h3>
      <p className="text-sm font-semibold text-foreground">{text.heading}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{text.explanation}</p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field
          label={`Maximum test budget (${plan.currency})`}
          htmlFor={inputId}
          hint="The most you are willing to spend on this whole test."
          error={error ?? undefined}
        >
          <Input
            id={inputId}
            inputMode="decimal"
            placeholder="e.g. 300"
            value={draft}
            invalid={Boolean(error)}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
            }}
          />
        </Field>
        <Field label="Test length">
          <SegmentedControl
            size="sm"
            options={BUDGET_TEST_DURATIONS.map((days) => ({ label: `${days} days`, value: String(days) }))}
            value={String(selectedDuration)}
            onChange={(value) => setSelectedDuration(Number(value) as 7 | 14 | 30)}
          />
        </Field>
      </div>

      <dl className="mt-5 grid gap-3 sm:grid-cols-3">
        {[
          ["Daily cap", text.daily],
          ["Maximum total spend", text.total],
          ["Test length", text.duration],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-surface-subtle px-3 py-2">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-subtle-foreground">{label}</dt>
            <dd className="mt-0.5 text-sm font-semibold text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
