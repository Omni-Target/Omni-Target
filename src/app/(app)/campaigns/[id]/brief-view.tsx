"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { BriefStep } from "@/components/campaigns/steps/brief-step";
import { BRIEFS_QUERY_KEY } from "@/components/campaigns/brief-history";
import type {
  GeneratedCopy,
  AiInsights,
  StoreInsights,
} from "@/components/campaigns/types";
import type {
  BriefPDFParams,
  CreativeHook,
  AdvantagePlusGuidance,
} from "@/lib/brief-pdf-types";
import { buildBriefPdfPayload, buildBriefText } from "@/lib/campaigns/brief";

// The full-screen PDF modal is only reached on click — load its chunk on demand.
const PdfBriefModal = dynamic(
  () =>
    import("@/components/campaigns/pdf-brief-modal").then(
      (m) => m.PdfBriefModal,
    ),
  { ssr: false },
);

// Full brief context persisted at finalize time (campaigns.brief_data). Optional
// throughout: if finalize didn't run, we fall back to the campaign's columns.
interface BriefData {
  brandName?: string;
  productName?: string;
  goal?: string;
  generatedCopy?: GeneratedCopy;
  selectedCta?: string;
  aiInsights?: AiInsights | null;
  creative_hooks?: CreativeHook[];
  advantage_plus_guidance?: AdvantagePlusGuidance;
  storeInsights?: StoreInsights | null;
  selectedStrategyIndex?: number;
  selectedIntlStrategyIndex?: number;
  selectedDuration?: 7 | 14 | 30;
  gatewayInsight?: BriefPDFParams["gatewayInsight"] | null;
  isNewLaunch?: boolean;
}

export interface BriefCampaign {
  id: string;
  brand_name: string | null;
  product_name: string | null;
  campaign_goal: string | null;
  headline: string | null;
  primary_text: string | null;
  description: string | null;
  cta: string | null;
  copywriter_note: string | null;
  brief_data: BriefData | null;
}

export interface BriefVersionRow {
  id: string;
  attempt_number: number;
  headline: string | null;
  primary_text: string | null;
  description: string | null;
  cta: string | null;
  copywriter_note: string | null;
  is_selected: boolean;
}

function versionToCopy(v: BriefVersionRow): GeneratedCopy {
  return {
    headline: v.headline ?? "",
    primaryText: v.primary_text ?? "",
    description: v.description ?? "",
    cta: v.cta ?? "",
    copywriterNote: v.copywriter_note ?? "",
  };
}

export function BriefView({
  campaign,
  versions = [],
}: {
  campaign: BriefCampaign;
  versions?: BriefVersionRow[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const bd: BriefData = campaign.brief_data ?? {};

  // The campaign's persisted (finalized) copy — prefer the rich brief_data, fall
  // back to columns so the page still renders if only the generate-time write
  // landed.
  const persistedCopy: GeneratedCopy = useMemo(
    () =>
      bd.generatedCopy ?? {
        headline: campaign.headline ?? "",
        primaryText: campaign.primary_text ?? "",
        description: campaign.description ?? "",
        cta: campaign.cta ?? "",
        copywriterNote: campaign.copywriter_note ?? "",
      },
    [bd.generatedCopy, campaign],
  );

  const brandName = bd.brandName ?? campaign.brand_name ?? "";
  const productName = bd.productName ?? campaign.product_name ?? "";
  const goal = bd.goal ?? campaign.campaign_goal ?? "";
  const aiInsights: AiInsights | null = useMemo(() => {
    if (bd.aiInsights) {
      return {
        ...bd.aiInsights,
        creative_hooks: bd.creative_hooks ?? bd.aiInsights.creative_hooks,
        advantage_plus_guidance:
          bd.advantage_plus_guidance ?? bd.aiInsights.advantage_plus_guidance,
      };
    }
    if (bd.creative_hooks || bd.advantage_plus_guidance) {
      return {
        creative_hooks: bd.creative_hooks,
        advantage_plus_guidance: bd.advantage_plus_guidance,
      } as AiInsights;
    }
    return null;
  }, [bd.aiInsights, bd.creative_hooks, bd.advantage_plus_guidance]);
  const storeInsights = bd.storeInsights ?? null;
  const gatewayInsight = bd.gatewayInsight ?? null;
  const isNewLaunch = bd.isNewLaunch ?? false;

  // Open on the finalized variation (or the first attempt); clicking any
  // variation in the rail switches the whole brief to it — and the active one is
  // always the "Chosen" one, so there's never more than one marked.
  const finalizedId = versions.find((v) => v.is_selected)?.id ?? null;
  const [activeVersionId, setActiveVersionId] = useState<string | null>(
    finalizedId ?? versions[0]?.id ?? null,
  );
  const activeVersion = versions.find((v) => v.id === activeVersionId) ?? null;

  // The copy shown + exported is whichever variation is being viewed.
  const displayedCopy: GeneratedCopy = activeVersion
    ? versionToCopy(activeVersion)
    : persistedCopy;
  const displayedCta =
    activeVersion && activeVersion.id !== finalizedId
      ? displayedCopy.cta
      : (bd.selectedCta ?? campaign.cta ?? displayedCopy.cta);

  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [selectedStrategyIndex, setSelectedStrategyIndex] = useState(
    bd.selectedStrategyIndex ?? 1,
  );
  const [selectedIntlStrategyIndex, setSelectedIntlStrategyIndex] = useState(
    bd.selectedIntlStrategyIndex ?? 1,
  );
  const [selectedDuration, setSelectedDuration] = useState<7 | 14 | 30>(
    bd.selectedDuration ?? 14,
  );
  const [modalOpen, setModalOpen] = useState(false);
  const [finalizing, setFinalizing] = useState(false);

  // PDF params for the currently viewed variation — the modal builds the PDF
  // from this (preview + download are the same document).
  const pdfParams = useMemo(
    () =>
      buildBriefPdfPayload({
        brandName,
        productName,
        goal,
        generatedCopy: displayedCopy,
        selectedCta: displayedCta,
        aiInsights,
        storeInsights,
        selectedDuration,
        selectedStrategyIndex,
        selectedIntlStrategyIndex,
        gatewayInsight,
        isNewLaunch,
      }),
    [
      brandName,
      productName,
      goal,
      displayedCopy,
      displayedCta,
      aiInsights,
      storeInsights,
      selectedDuration,
      selectedStrategyIndex,
      selectedIntlStrategyIndex,
      gatewayInsight,
      isNewLaunch,
    ],
  );

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  const handleCopyBrief = () => {
    const briefText = buildBriefText({
      generatedCopy: displayedCopy,
      selectedCta: displayedCta,
      aiInsights,
      storeInsights,
      goal,
      selectedStrategyIndex,
      selectedDuration,
      gatewayInsight,
    });
    navigator.clipboard.writeText(briefText);
    setCopiedField("full-brief");
    setTimeout(() => setCopiedField(null), 2000);
  };

  // Finalize: persist the chosen variation + mark complete, then head back to
  // the dashboard. Best-effort persistence never blocks the redirect.
  const handleFinalize = async () => {
    setFinalizing(true);
    try {
      await fetch(`/api/campaigns/${campaign.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versionId: activeVersionId,
          copy: displayedCopy,
          status: "complete",
        }),
      });
      queryClient.invalidateQueries({ queryKey: BRIEFS_QUERY_KEY });
    } catch (err) {
      console.error("Failed to finalize campaign:", err);
    }
    router.push("/dashboard");
  };

  const hasRail = versions.length > 0;

  return (
    <>
      <div
        className={cn(
          hasRail &&
            "grid gap-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start",
        )}
      >
        {hasRail && (
          <aside className="lg:sticky lg:top-24">
            <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-subtle-foreground">
              <Layers className="size-3.5" /> Variations
            </div>
            <div className="flex flex-col gap-1.5">
              {versions.map((v) => {
                const isActive = v.id === activeVersionId;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setActiveVersionId(v.id)}
                    aria-current={isActive ? "true" : undefined}
                    className={cn(
                      "flex items-center justify-between rounded-xl border px-3 py-2.5 text-left text-sm font-medium transition-colors",
                      isActive
                        ? "border-brand-300 bg-brand-50 text-brand-700 shadow-xs"
                        : "border-border bg-surface text-muted-foreground hover:border-border-strong hover:bg-surface-subtle",
                    )}
                  >
                    <span>Variation {v.attempt_number}</span>
                    {isActive && (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600">
                        <Check className="size-3.5" /> Chosen
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Click a variation to preview it — the PDF exports the one
              you&apos;re viewing.
            </p>
          </aside>
        )}

        <div className="min-w-0">
          <BriefStep
            className={hasRail ? "w-full" : "mx-auto max-w-3xl"}
            generatedCopy={displayedCopy}
            copiedField={copiedField}
            onCopy={handleCopy}
            selectedCta={displayedCta}
            storeInsights={storeInsights}
            aiInsights={aiInsights}
            loadingAiInsights={false}
            goal={goal}
            selectedStrategyIndex={selectedStrategyIndex}
            setSelectedStrategyIndex={setSelectedStrategyIndex}
            selectedIntlStrategyIndex={selectedIntlStrategyIndex}
            setSelectedIntlStrategyIndex={setSelectedIntlStrategyIndex}
            selectedDuration={selectedDuration}
            setSelectedDuration={setSelectedDuration}
            isDownloadingPdf={false}
            onDownloadPdf={() => setModalOpen(true)}
            onCopyBrief={handleCopyBrief}
            onCreateNew={() => router.push("/campaigns")}
            gatewayInsight={gatewayInsight}
          />
        </div>
      </div>

      {modalOpen && (
        <PdfBriefModal
          open
          params={pdfParams}
          onFinalize={handleFinalize}
          finalizing={finalizing}
        />
      )}
    </>
  );
}
