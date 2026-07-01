import { ArrowRight, Check, FileText, ImageIcon, Info, RefreshCw, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AdPreview } from "../ad-preview";
import { CopyField } from "../copy-field";
import { CtaSelector } from "../cta-selector";
import type { GeneratedCopy } from "../types";

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
  onUploadDifferent: () => void;
  onRegenerate: () => void;
  onStartOver: () => void;
  onGenerateBrief: () => void;
}

/** "Review generated copy" step — ad preview, copy fields, CTA, and next actions. */
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
  onUploadDifferent,
  onRegenerate,
  onStartOver,
  onGenerateBrief,
}: ReviewStepProps) {
  return (
    <div>
      <div className="mb-8">
        <Badge variant="success" className="mb-3">
          <Check className="size-3" /> AI creatives ready
        </Badge>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground sm:text-3xl">
          Review generated copy
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Preview your personalised Meta ad and fine-tune the call to action.
        </p>
      </div>

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
