import type * as React from "react";
import { Check, Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CopyField } from "../copy-field";
import { TargetingSummary } from "../targeting-summary";
import { BudgetPlanner } from "../budget-planner";
import type { GeneratedCopy, AiInsights, StoreInsights } from "../types";

export interface BriefStepProps {
  generatedCopy: GeneratedCopy;
  copiedField: string | null;
  onCopy: (text: string, field: string) => void;
  selectedCta: string;
  storeInsights: StoreInsights | null;
  aiInsights: AiInsights | null;
  loadingAiInsights: boolean;
  goal: string;
  selectedStrategyIndex: number;
  setSelectedStrategyIndex: React.Dispatch<React.SetStateAction<number>>;
  selectedDuration: 7 | 14 | 30;
  setSelectedDuration: React.Dispatch<React.SetStateAction<7 | 14 | 30>>;
  isDownloadingPdf: boolean;
  onDownloadPdf: () => void;
  onCopyBrief: () => void;
  onCreateNew: () => void;
}

/** Final "Your campaign brief is ready" step — copy, targeting, budget, exports. */
export function BriefStep({
  generatedCopy,
  copiedField,
  onCopy,
  selectedCta,
  storeInsights,
  aiInsights,
  loadingAiInsights,
  goal,
  selectedStrategyIndex,
  setSelectedStrategyIndex,
  selectedDuration,
  setSelectedDuration,
  isDownloadingPdf,
  onDownloadPdf,
  onCopyBrief,
  onCreateNew,
}: BriefStepProps) {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl bg-success-50 text-success-600">
          <Check className="size-7" />
        </div>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground sm:text-3xl">
          Your campaign brief is ready
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Take this into Meta Ads Manager to set up your campaign.
        </p>
      </div>

      <div className="space-y-6">
        <Card className="p-6">
          <h3 className="mb-5 text-sm font-semibold uppercase tracking-widest text-subtle-foreground">
            Ad copy
          </h3>
          <div className="space-y-4">
            <CopyField
              label="Headline"
              value={generatedCopy.headline}
              fieldKey="brief-headline"
              copiedField={copiedField}
              onCopy={onCopy}
              emphasis="strong"
            />
            <CopyField
              label="Primary text"
              value={generatedCopy.primaryText}
              fieldKey="brief-primary"
              copiedField={copiedField}
              onCopy={onCopy}
            />
            <CopyField
              label="Description"
              value={generatedCopy.description}
              fieldKey="brief-desc"
              copiedField={copiedField}
              onCopy={onCopy}
              emphasis="muted"
            />
            <CopyField
              label="Call to action"
              value={selectedCta || generatedCopy.cta}
              fieldKey="brief-cta"
              copiedField={copiedField}
              onCopy={onCopy}
              emphasis="strong"
            />
          </div>
        </Card>

        <TargetingSummary
          storeInsights={storeInsights}
          aiInsights={aiInsights}
          loadingAiInsights={loadingAiInsights}
        />

        <BudgetPlanner
          aiInsights={aiInsights}
          goal={goal}
          selectedStrategyIndex={selectedStrategyIndex}
          setSelectedStrategyIndex={setSelectedStrategyIndex}
          selectedDuration={selectedDuration}
          setSelectedDuration={setSelectedDuration}
          loadingAiInsights={loadingAiInsights}
        />

        {storeInsights?.orders?.peak_days &&
          storeInsights.orders.peak_days.length > 0 && (
            <Card className="p-6">
              <h3 className="mb-5 text-sm font-semibold uppercase tracking-widest text-subtle-foreground">
                Timing
              </h3>
              <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-faint-foreground">
                Best days to run
              </span>
              <p className="mt-1 text-sm text-foreground">
                {storeInsights.orders.peak_days.join(", ")}
              </p>
            </Card>
          )}

        <div className="space-y-3 pt-2">
          <Button
            size="xl"
            className="w-full"
            isLoading={isDownloadingPdf}
            onClick={onDownloadPdf}
          >
            {!isDownloadingPdf && <Download className="size-4" />}
            {isDownloadingPdf
              ? "Generating premium PDF…"
              : "Download PDF brief"}
          </Button>
          <Button variant="secondary" className="w-full" onClick={onCopyBrief}>
            {copiedField === "full-brief" ? (
              <>
                <Check className="size-4" /> Copied
              </>
            ) : (
              <>
                <Copy className="size-4" /> Copy brief to clipboard
              </>
            )}
          </Button>
          <Button variant="ghost" className="w-full" onClick={onCreateNew}>
            Create new brief
          </Button>
        </div>
      </div>
    </div>
  );
}
