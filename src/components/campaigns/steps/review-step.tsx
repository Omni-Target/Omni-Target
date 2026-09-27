import { useState } from "react";
import { AlertCircle, ArrowRight, Check, FileText, ImageIcon, Info, Layers, Loader2, RefreshCw, RotateCcw, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { AdPreview } from "../ad-preview";
import { CopyField } from "../copy-field";
import { CtaSelector } from "../cta-selector";
import { CreativeHooksCard } from "../creative-hooks-card";
import type { GeneratedCopy, AiInsights, CreativeHook } from "../types";

export interface BriefVariation {
  versionId: string | null;
  copy: GeneratedCopy;
  tone: string;
  aiInsights?: AiInsights | null;
}

const COCKPIT_TONES = [
  { id: "Minimal & Editorial", label: "Minimal & Editorial" },
  { id: "Bold & Direct", label: "Bold & Direct" },
  { id: "Warm & Conversational", label: "Warm & Conversational" },
  { id: "Premium & Aspirational", label: "Premium & Aspirational" },
  { id: "Let AI decide", label: "AI Auto" },
] as const;

export interface ReviewStepProps {
  generatedCopy: GeneratedCopy;
  previewPlatform: "facebook" | "instagram";
  onPlatformChange: (platform: "facebook" | "instagram") => void;
  brandName: string;
  mediaCloudUrl: string;
  isVideo: boolean;
  selectedCta: string;
  onSelectCta: (cta: string) => void;
  resolvedStoreDomain: string;
  copiedField: string | null;
  onCopy: (text: string, field: string) => void;
  regenerateCount: number;
  // Every generation attempt for this session, so the user can compare and pick
  // one before proceeding. The shown variation is the one that continues.
  variations: BriefVariation[];
  selectedVariationIndex: number;
  onSelectVariation: (index: number) => void;
  onUploadDifferent: () => void;
  onRegenerate: (newTone?: string) => void;
  onStartOver: () => void;
  onGenerateBrief: () => void;
  isFinalizing?: boolean;
  errorMsg?: string;
  hooks?: CreativeHook[];
  hooksLoading?: boolean;
  hooksGenerationStatus?: "generated" | "fallback";
  onRetryHooks?: () => void;
  hooksRetryError?: string | null;
  goal?: string;
  tone?: string;
  gatewayClassification?: string | null;
}

/** "Review generated copy" step — ad preview, copy fields, CTA, hooks, and next actions. */
export function ReviewStep({
  generatedCopy,
  previewPlatform,
  onPlatformChange,
  brandName,
  mediaCloudUrl,
  isVideo,
  selectedCta,
  onSelectCta,
  resolvedStoreDomain,
  copiedField,
  onCopy,
  regenerateCount,
  variations,
  selectedVariationIndex,
  onSelectVariation,
  onUploadDifferent,
  onRegenerate,
  onStartOver,
  onGenerateBrief,
  isFinalizing = false,
  errorMsg,
  hooks,
  hooksLoading = false,
  hooksGenerationStatus,
  onRetryHooks,
  hooksRetryError,
  goal,
  tone,
  gatewayClassification,
}: ReviewStepProps) {
  const [selectedVoice, setSelectedVoice] = useState<string>(
    tone || "Let AI decide",
  );

  return (
    <div>
      <div className="mb-6">
        <Badge variant="success" className="mb-3">
          <Check className="size-3" /> {hooksGenerationStatus === "fallback" ? "Ad copy ready" : "Creatives ready"}
        </Badge>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground sm:text-3xl">
          Review generated copy
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Preview your personalised Meta ad and fine-tune the call to action.
        </p>
      </div>

      {/* Strategy & Voice Cockpit */}
      <div className="mb-6 rounded-2xl border border-border bg-surface-subtle p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 border border-brand-200/80 dark:bg-brand-950/40 dark:border-brand-900">
              <Sparkles className="size-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-faint-foreground">
                  Active Strategy
                </span>
                {gatewayClassification?.toLowerCase() === "gateway" && (
                  <Badge variant="brand" size="sm">
                    Gateway Product
                  </Badge>
                )}
              </div>
              <p className="text-sm font-semibold text-foreground">
                {goal || "Drive Website Sales"} ·{" "}
                <span className="font-normal text-muted-foreground">
                  Active Voice: {tone || "Let AI decide"}
                </span>
              </p>
            </div>
          </div>

          {/* Quick Voice Switcher */}
          {regenerateCount < 3 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground mr-1">
                Try another voice:
              </span>
              {COCKPIT_TONES.map((t) => {
                const isActive = selectedVoice === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelectedVoice(t.id)}
                    className={cn(
                      "rounded-lg border px-2.5 py-1 text-xs font-medium transition-all",
                      isActive
                        ? "border-brand-600 bg-brand-50 text-brand-700 font-semibold dark:bg-brand-950/60 dark:text-brand-300"
                        : "border-border bg-surface text-muted-foreground hover:border-border-strong hover:text-foreground",
                    )}
                  >
                    {t.label}
                  </button>
                );
              })}
              {selectedVoice !== tone && (
                <Button
                  size="sm"
                  variant="primary"
                  className="ml-2 h-7 px-2.5 text-xs"
                  onClick={() => onRegenerate(selectedVoice)}
                >
                  <RefreshCw className="size-3" />
                  Apply Voice
                </Button>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">3 free voice variations used</span> (pick your favourite below)
            </div>
          )}
        </div>
        {errorMsg && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50/80 px-3 py-2 text-xs font-medium text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
            <AlertCircle className="size-4 shrink-0 text-red-600 dark:text-red-400" />
            <span>{errorMsg}</span>
          </div>
        )}
      </div>

      {variations.length > 1 && (
        <div className="mb-6">
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-subtle-foreground">
            <Layers className="size-3.5" /> Compare variations
          </div>
          <div className="flex flex-wrap gap-2">
            {variations.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onSelectVariation(i)}
                className={cn(
                  "inline-flex items-center rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
                  i === selectedVariationIndex
                    ? "border-brand-600 bg-brand-50 text-brand-700"
                    : "border-border bg-surface text-muted-foreground hover:border-border-strong hover:bg-surface-subtle",
                )}
              >
                Variation {i + 1}
                {i === selectedVariationIndex && (
                  <Check className="ml-1.5 size-3.5" />
                )}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Viewing variation {selectedVariationIndex + 1} of {variations.length}
            . The one shown here is the one that continues to your brief.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <div className="space-y-6 xl:col-span-8">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <AdPreview
              platform={previewPlatform}
              onPlatformChange={onPlatformChange}
              brandName={brandName}
              mediaCloudUrl={mediaCloudUrl}
              isVideo={isVideo}
              copy={generatedCopy}
              selectedCta={selectedCta}
              storeDomain={resolvedStoreDomain}
            />

            <Card className="flex h-fit flex-col p-5">
              <h3 className="mb-4 text-base font-semibold text-foreground">
                Ad copy details
              </h3>
              <div className="flex-1 space-y-5">
                <CopyField
                  label="Primary text"
                  value={generatedCopy.primaryText}
                  fieldKey="primaryText"
                  copiedField={copiedField}
                  onCopy={onCopy}
                />
                <CopyField
                  label="Headline"
                  value={generatedCopy.headline}
                  fieldKey="headline"
                  copiedField={copiedField}
                  onCopy={onCopy}
                  emphasis="strong"
                />
                <CopyField
                  label="Link description"
                  value={generatedCopy.description}
                  fieldKey="description"
                  copiedField={copiedField}
                  onCopy={onCopy}
                  emphasis="muted"
                />
              </div>
              <div className="mt-5">
                <CtaSelector selectedCta={selectedCta} onSelect={onSelectCta} />
              </div>
            </Card>
          </div>
        </div>

        <div className="space-y-4 xl:col-span-4">
          <Card variant="gradient" className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <Info className="size-4 text-brand-600" />
              <h3 className="text-xs font-bold uppercase tracking-widest text-brand-700">
                Why this approach
              </h3>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {generatedCopy.copywriterNote ||
                "Written to catch shoppers' attention in their feed, highlight the real product details, and encourage them to visit your store and buy."}
            </p>
          </Card>

          <Card className="p-5">
            <p className="mb-4 text-center text-xs text-subtle-foreground">
              Not quite right?
            </p>
            <div className="space-y-3">
              <Button
                variant="secondary"
                className="w-full"
                onClick={onUploadDifferent}
              >
                <ImageIcon className="size-4" /> Upload different creative
              </Button>
              {regenerateCount < 3 && (
                <Button
                  variant={selectedVoice !== tone ? "primary" : "secondary"}
                  className="w-full"
                  onClick={() =>
                    onRegenerate(
                      selectedVoice !== tone ? selectedVoice : undefined,
                    )
                  }
                >
                  <RefreshCw className="size-4" />
                  {selectedVoice !== tone
                    ? `Generate in ${selectedVoice} (${3 - regenerateCount} free left)`
                    : `Generate another variation (${3 - regenerateCount} free left)`}
                </Button>
              )}
              <Button
                variant="danger-soft"
                className="w-full"
                onClick={onStartOver}
              >
                <RotateCcw className="size-4" /> Start over
              </Button>
            </div>
          </Card>
        </div>
      </div>

      <div className="mt-8">
        <CreativeHooksCard
          hooks={hooks}
          loading={hooksLoading}
          generationStatus={hooksGenerationStatus}
          onRetry={onRetryHooks}
          retryError={hooksRetryError}
        />
      </div>

      <div className="mx-auto mt-8 max-w-3xl">
        <Button
          size="xl"
          className="w-full"
          onClick={onGenerateBrief}
          disabled={hooksLoading || isFinalizing}
        >
          {isFinalizing ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Finalizing campaign brief…
            </>
          ) : hooksLoading ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Adding your 3 creative angles…
            </>
          ) : (
            <>
              <FileText className="size-4" /> Generate campaign brief
              <ArrowRight className="size-4" />
            </>
          )}
        </Button>
        {errorMsg && (
          <p role="alert" className="mt-2 text-center text-xs font-medium text-red-600">
            {errorMsg}
          </p>
        )}
        <p className="mt-3 text-center text-xs text-subtle-foreground">
          {hooksLoading
            ? "Preparing 3 ready-to-use hooks so you have multiple creative options to test…"
            : hooksGenerationStatus === "fallback"
              ? "Your copy and campaign settings are saved. Retry hooks above to complete the creative options."
              : "Your brief will contain everything you need to set up this campaign in Meta Ads Manager."}
        </p>
      </div>
    </div>
  );
}
