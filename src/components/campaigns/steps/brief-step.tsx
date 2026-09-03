import type * as React from "react";
import { Check, Copy, Download, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CopyField } from "../copy-field";
import { CreativeHooksCard } from "../creative-hooks-card";
import { TargetingSummary } from "../targeting-summary";
import { BudgetPlanner } from "../budget-planner";
import type { GeneratedCopy, AiInsights, StoreInsights } from "../types";
import type { BriefPDFParams } from "@/lib/brief-pdf-types";

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
  selectedIntlStrategyIndex?: number;
  setSelectedIntlStrategyIndex?: React.Dispatch<React.SetStateAction<number>>;
  selectedDuration: 7 | 14 | 30;
  setSelectedDuration: React.Dispatch<React.SetStateAction<7 | 14 | 30>>;
  isDownloadingPdf: boolean;
  onDownloadPdf: () => void;
  onCopyBrief: () => void;
  onCreateNew: () => void;
  gatewayInsight?: BriefPDFParams["gatewayInsight"] | null;
  // Outer container class — defaults to a centered narrow column; the durable
  // /campaigns/[id] page overrides it to fill the width beside its rail.
  className?: string;
}

/** Final "Your campaign brief is ready" step — copy, creative hooks, targeting, budget, exports. */
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
  selectedIntlStrategyIndex,
  setSelectedIntlStrategyIndex,
  selectedDuration,
  setSelectedDuration,
  isDownloadingPdf,
  onDownloadPdf,
  onCopyBrief,
  onCreateNew,
  gatewayInsight,
  className = "mx-auto max-w-3xl",
}: BriefStepProps) {
  const isGateway = gatewayInsight?.currentProductClassification === "Gateway";

  return (
    <div className={className}>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground sm:text-3xl">
          Your campaign brief is ready
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Take this into Meta Ads Manager to set up your Advantage+ campaign.
        </p>
      </div>

      {isGateway && (
        <div className="mb-6 flex items-start gap-3.5 rounded-2xl border border-brand-200 bg-brand-50/60 p-4.5 shadow-xs">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-600 text-white shadow-xs">
            <Sparkles className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-brand-950">
                Gateway Product
              </span>
              <span className="rounded-full bg-brand-200/80 px-2 py-0.5 text-[11px] font-semibold text-brand-800">
                Cold Traffic Magnet
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-brand-800">
              This product is verified as a top Gateway Product — best for turning cold strangers into first-time customers. The hooks, copy, and targeting below are optimized to acquire new buyers.
            </p>
          </div>
        </div>
      )}

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

        <CreativeHooksCard
          hooks={aiInsights?.creative_hooks}
          loading={loadingAiInsights}
        />

        <TargetingSummary
          storeInsights={storeInsights}
          aiInsights={aiInsights}
          loadingAiInsights={loadingAiInsights}
          selectedIntlStrategyIndex={selectedIntlStrategyIndex}
        />

        <BudgetPlanner
          aiInsights={aiInsights}
          storeInsights={storeInsights}
          goal={goal}
          selectedStrategyIndex={selectedStrategyIndex}
          setSelectedStrategyIndex={setSelectedStrategyIndex}
          selectedIntlStrategyIndex={selectedIntlStrategyIndex}
          setSelectedIntlStrategyIndex={setSelectedIntlStrategyIndex}
          selectedDuration={selectedDuration}
          setSelectedDuration={setSelectedDuration}
          loadingAiInsights={loadingAiInsights}
        />

        {Boolean(
          (storeInsights?.orders?.peak_days &&
            storeInsights.orders.peak_days.length > 0) ||
            aiInsights?.timing?.launch_recommendation
        ) && (
          <Card className="p-6">
            <h3 className="mb-5 text-sm font-semibold uppercase tracking-widest text-subtle-foreground">
              Campaign schedule &amp; expectations
            </h3>
            {aiInsights?.timing?.launch_recommendation ? (
              <div className="mb-4">
                <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-faint-foreground">
                  Launch schedule
                </span>
                <p className="mt-1 text-sm text-foreground">
                  {aiInsights.timing.launch_recommendation}
                </p>
              </div>
            ) : null}
            {storeInsights?.orders?.peak_days &&
            storeInsights.orders.peak_days.length > 0 ? (
              <div className="mb-4">
                <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-faint-foreground">
                  Peak store buying days
                </span>
                <p className="mt-1 text-sm text-foreground">
                  {storeInsights.orders.peak_days.join(" · ")}
                </p>
              </div>
            ) : null}
            {aiInsights?.timing?.reasoning ? (
              <p className="text-xs text-subtle-foreground">
                {aiInsights.timing.reasoning}
              </p>
            ) : null}
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
            {isDownloadingPdf ? "Preparing…" : "Generate PDF brief"}
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
