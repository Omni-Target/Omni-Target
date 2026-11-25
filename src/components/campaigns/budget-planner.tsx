"use client";

import { useId, useState } from "react";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { budgetPlanFor } from "@/lib/campaigns/brief";
import { BUDGET_TEST_DURATIONS, describeBudgetPlan, normalizeMaxTotalBudget } from "@/lib/budget-plan";
import { describeBriefEconomics, type BriefEconomics } from "@/lib/brief-economics";
import type { AiInsights, StoreInsights } from "./types";

/**
 * Test budget. Phase 4: a brief linked to a product shows the deterministic engine's recorded recommendation
 * (verdict, per-order economics and a budget within the merchant's limits), worded by describeBriefEconomics()
 * like the PDF and plain text. Changing the limit or the test length asks the server to recalculate; nothing is
 * computed here. Briefs saved before Phase 4 keep the S0.6 view: the merchant's own maximum, split evenly.
 */
interface BudgetPlannerProps {
  aiInsights: AiInsights | null;
  storeInsights: StoreInsights | null;
  selectedDuration: 7 | 14 | 30;
  setSelectedDuration: (duration: 7 | 14 | 30) => void;
  maxTestBudget: number | null;
  setMaxTestBudget: (value: number | null) => void;
  economics?: BriefEconomics | null;
  recalculating?: boolean;
  /** Records the merchant's confirmation that the product's zero unit cost is correct, then recalculates. */
  onConfirmZeroCost?: () => void;
}

const VERDICT_TONE: Record<string, string> = {
  GO: "border-emerald-300 bg-emerald-50 text-emerald-800",
  PILOT: "border-sky-300 bg-sky-50 text-sky-800",
  DO_NOT_LAUNCH: "border-red-300 bg-red-50 text-red-800",
  BLOCKED: "border-red-300 bg-red-50 text-red-800",
  INSUFFICIENT_DATA: "border-amber-300 bg-amber-50 text-amber-800",
};

export function BudgetPlanner({
  aiInsights,
  storeInsights,
  selectedDuration,
  setSelectedDuration,
  maxTestBudget,
  setMaxTestBudget,
  economics = null,
  recalculating = false,
  onConfirmZeroCost,
}: BudgetPlannerProps) {
  const inputId = useId();
  const [draft, setDraft] = useState(maxTestBudget != null ? String(maxTestBudget) : "");
  const [error, setError] = useState<string | null>(null);

  const plan = budgetPlanFor({ aiInsights, storeInsights, maxTestBudget, selectedDuration });
  const engine = economics ? describeBriefEconomics(economics) : null;
  const text = engine ?? describeBudgetPlan(plan);
  const currency = economics?.currency ?? plan.currency;

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
    <Card className="p-6" aria-busy={recalculating}>
      <h3 className="mb-1 text-sm font-semibold uppercase tracking-widest text-subtle-foreground">
        {engine ? "Economics and test budget" : "Test budget"}
      </h3>

      {engine && (
        <div className="mb-4 space-y-3">
          <p className={`inline-block rounded-md border px-2 py-1 text-xs font-semibold ${engine.verdict ? VERDICT_TONE[engine.verdict] : "border-border"}`}>
            {engine.verdict_label}
          </p>
          {onConfirmZeroCost && economics?.reasons?.some((r) => r.code === "UNIT_COST_ZERO") && (
            <button type="button" disabled={recalculating} onClick={onConfirmZeroCost}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2">
              Confirm the variants with a zero unit cost really cost nothing
            </button>
          )}
          {engine.reasons.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
              {engine.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          )}
          {engine.figures.length > 0 && (
            <dl className="grid gap-2 sm:grid-cols-2">
              {engine.figures.map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3 border-b border-border py-1">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="text-sm font-semibold text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}

      <p className="text-sm font-semibold text-foreground">{text.heading}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{text.explanation}</p>
      {recalculating && <p role="status" className="mt-2 text-xs text-muted-foreground">Recalculating…</p>}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field
          label={`${engine ? "Most you will spend on this test" : "Maximum test budget"} (${currency})`}
          htmlFor={inputId}
          hint={engine ? "Your limit for this product. The recommendation never exceeds it." : "The most you are willing to spend on this whole test."}
          error={error ?? undefined}
        >
          <Input
            id={inputId}
            inputMode="decimal"
            placeholder="e.g. 300"
            value={draft}
            invalid={Boolean(error)}
            disabled={recalculating}
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
          [engine ? "Daily budget" : "Daily cap", text.daily],
          [engine ? "Test budget" : "Maximum total spend", text.total],
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
