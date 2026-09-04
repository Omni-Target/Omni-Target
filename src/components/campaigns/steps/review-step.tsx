import { ArrowRight, Check, FileText, ImageIcon, Info, Layers, RefreshCw, RotateCcw } from "lucide-react";
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
  aiInsights?: AiInsights | null;
}

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
  onRegenerate: () => void;
  onStartOver: () => void;
  onGenerateBrief: () => void;
  hooks?: CreativeHook[];
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
  hooks,
}: ReviewStepProps) {
  return (
    <div>
      <div className="mb-8">
        <Badge variant="success" className="mb-3">
          <Check className="size-3" /> Creatives ready
        </Badge>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground sm:text-3xl">
          Review generated copy
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Preview your personalised Meta ad and fine-tune the call to action.
        </p>
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
              {generatedCopy.copywriterNote}
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
                  variant="secondary"
                  className="w-full"
                  onClick={onRegenerate}
                >
                  <RefreshCw className="size-4" /> Generate another variation (
                  {3 - regenerateCount} free left)
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

      {hooks && hooks.length > 0 && (
        <div className="mt-8">
          <CreativeHooksCard hooks={hooks} />
        </div>
      )}

      <div className="mx-auto mt-8 max-w-3xl">
        <Button size="xl" className="w-full" onClick={onGenerateBrief}>
          <FileText className="size-4" /> Generate campaign brief
          <ArrowRight className="size-4" />
        </Button>
        <p className="mt-3 text-center text-xs text-subtle-foreground">
          Your brief will contain everything you need to set up this campaign in
          Meta Ads Manager.
        </p>
      </div>
    </div>
  );
}
