"use client";

import React, { useState, useEffect, Suspense, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { FileText } from "lucide-react";
import type { BriefPDFParams } from "@/lib/generate-brief-pdf";
import { PageContainer } from "@/components/layout/page-container";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import {
  StepRail,
  SelectionStep,
  GeneratingState,
  type GeneratedCopy,
} from "@/components/campaigns";
import { MediaStep } from "@/components/campaigns/steps/media-step";
import { InputStep } from "@/components/campaigns/steps/input-step";
import { ReviewStep } from "@/components/campaigns/steps/review-step";
import { BriefStep } from "@/components/campaigns/steps/brief-step";
import { useMediaUpload } from "@/components/campaigns/use-media-upload";
import { useStoreInsights } from "@/components/campaigns/use-store-insights";
import {
  useCampaignForm,
  type CampaignFormState,
} from "@/components/campaigns/use-campaign-form";
import { buildGenerationContext } from "@/lib/campaigns/insights";
import { buildBriefPdfPayload, buildBriefText } from "@/lib/campaigns/brief";
import {
  resolveStoreDomain,
  validateCampaignForm,
} from "@/lib/campaigns/derive";

type CampaignState =
  | "selection"
  | "media"
  | "input"
  | "generating"
  | "review"
  | "brief";

const STEP_INDEX: Record<CampaignState, number> = {
  selection: 0,
  media: 0,
  input: 1,
  generating: 1,
  review: 2,
  brief: 3,
};

function CampaignsContent() {
  const router = useRouter();
  const { user } = useUser();
  const { toast } = useToast();
  const storeUrl = (user?.publicMetadata?.shopifyStoreUrl as string) || "";

  const [previewPlatform, setPreviewPlatform] = useState<
    "facebook" | "instagram"
  >("facebook");

  const generatingRef = useRef(false);
  const [viewState, setViewState] = useState<CampaignState>("selection");
  const [loadingDraft, setLoadingDraft] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [showBuyCredits, setShowBuyCredits] = useState(false);

  // Ad-creative upload state + pipeline (presign → PUT → validate → derive isVideo).
  const {
    fileInputRef,
    mediaFile,
    mediaPreviewUrl,
    mediaCloudUrl,
    mediaValidation,
    isUploading,
    uploadError,
    isVideo,
    handleMediaSelect,
    applyDraftImage,
    resetMedia,
  } = useMediaUpload();

  // Campaign form state — one reducer; resetForm() clears every field (so a new
  // field can't be forgotten on Start Over / Create New).
  const {
    brandName,
    productName,
    description,
    productPrice,
    productVariants,
    goal,
    tone,
    isNewLaunch,
    autoFilledFromStore,
    setBrandName,
    setProductName,
    setDescription,
    setGoal,
    setTone,
    applyDraft,
    resetForm,
  } = useCampaignForm();

  const [generatedCopy, setGeneratedCopy] = useState<GeneratedCopy | null>(
    null,
  );

  // Review state
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  // Holds the generated brief's blob URL when the browser blocks the auto-open
  // pop-up, so we can offer a click-to-open link in a modal instead.
  const [pdfFallbackUrl, setPdfFallbackUrl] = useState<string | null>(null);
  const [selectedCta, setSelectedCta] = useState<string>("");

  const handleReauthRequired = useCallback(
    () => router.replace("/dashboard"),
    [router],
  );
  const { storeInsights, aiInsights, loadingAiInsights } = useStoreInsights({
    onReauthRequired: handleReauthRequired,
    onStoreName: setBrandName,
  });
  const [gatewayInsight, setGatewayInsight] = useState<
    BriefPDFParams["gatewayInsight"] | null
  >(null);
  const [selectedStrategyIndex, setSelectedStrategyIndex] = useState(1);
  const [selectedDuration, setSelectedDuration] = useState<7 | 14 | 30>(14);
  const [regenerateCount, setRegenerateCount] = useState(0);

  // Read from sessionStorage for auto-fill (client-only init from external store)
  useEffect(() => {
    const draftStr = sessionStorage.getItem("campaign_draft");
    if (draftStr) {
      try {
        const draft = JSON.parse(draftStr);
        if (draft.product_name) {
          const formValues: Partial<CampaignFormState> = {
            productName: draft.product_name,
            autoFilledFromStore: true,
          };
          if (draft.product_description)
            formValues.description = draft.product_description;
          if (draft.product_price) formValues.productPrice = draft.product_price;
          if (draft.product_variants)
            formValues.productVariants = draft.product_variants;
          if (draft.is_new_launch) formValues.isNewLaunch = true;
          applyDraft(formValues);
          if (draft.product_image) applyDraftImage(draft.product_image);
          setViewState("input");
          sessionStorage.removeItem("campaign_draft");
        }
      } catch (e) {
        console.error("Failed to parse campaign draft", e);
      }
    }
    setLoadingDraft(false);
  }, [applyDraft, applyDraftImage]);

  const resolvedStoreDomain = resolveStoreDomain(storeInsights, storeUrl);

  // Prevent accidental navigation during generation
  useEffect(() => {
    if (viewState === "generating") {
      const handlePopState = () => {
        window.history.pushState(null, "", window.location.href);
      };
      window.history.pushState(null, "", window.location.href);
      window.addEventListener("popstate", handlePopState);
      const handleBeforeUnload = (e: BeforeUnloadEvent) => {
        e.preventDefault();
        e.returnValue = "";
      };
      window.addEventListener("beforeunload", handleBeforeUnload);
      return () => {
        window.removeEventListener("popstate", handlePopState);
        window.removeEventListener("beforeunload", handleBeforeUnload);
      };
    }
  }, [viewState]);

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  const handleGenerate = async (isRegeneration = false) => {
    // Guard against double-submission, including same-tick double-clicks that a
    // state-based check would miss (state updates are async). A ref flips
    // synchronously so the second call returns immediately.
    if (generatingRef.current) return;

    const errors = validateCampaignForm({ brandName, productName, description });
    if (errors.length > 0) {
      setErrorMsg(errors.join(". "));
      return;
    }

    generatingRef.current = true;
    setViewState("generating");
    setErrorMsg("");
    setShowBuyCredits(false);

    const {
      gatewayInsight: derivedGatewayInsight,
      storeDataForApi,
      storePrices,
    } = buildGenerationContext(storeInsights, productName);
    if (derivedGatewayInsight) setGatewayInsight(derivedGatewayInsight);

    try {
      const res = await fetch("/api/campaigns/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandName,
          productName,
          productDescription: description,
          campaignGoal: goal,
          tonePreference: tone,
          mediaUrl: mediaCloudUrl || mediaPreviewUrl || null,
          imageUrl: mediaCloudUrl || null,
          productPrice: productPrice || null,
          storeAov: storeInsights?.orders?.average_order_value ?? null,
          storePrices,
          productVariants: productVariants || null,
          gatewayInsight: derivedGatewayInsight,
          storeDataForApi,
          isNewLaunch,
          isRegeneration,
          shopifyStoreCountry: storeInsights?.store?.country || null,
          topCustomerLocations: storeInsights?.orders?.top_locations || null,
        }),
      });

      const data = await res.json();

      if (res.status === 402 || data.error === "no_credits") {
        setErrorMsg(
          "You have no briefs remaining. Purchase a pack to continue.",
        );
        setShowBuyCredits(true);
        setViewState("input");
        return;
      }

      if (!res.ok) {
        const errorDetail =
          typeof data.error === "object"
            ? data.error.message || JSON.stringify(data.error)
            : data.error;
        throw new Error(errorDetail || "API returned an error");
      }

      const generatedCopyData: GeneratedCopy = data;
      setGeneratedCopy(generatedCopyData);
      setSelectedCta(generatedCopyData.cta);
      if (isRegeneration) setRegenerateCount((prev) => prev + 1);
      setViewState("review");
    } catch (err) {
      console.error(err);
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again.",
      );
      setViewState("input");
    } finally {
      generatingRef.current = false;
    }
  };

  const handleStartOver = (targetState?: CampaignState | React.MouseEvent) => {
    const finalState = typeof targetState === "string" ? targetState : "media";
    resetForm();
    setGeneratedCopy(null);
    setErrorMsg("");
    setShowBuyCredits(false);
    setRegenerateCount(0);
    resetMedia();
    setViewState(finalState);
  };

  const handleDownloadPdf = async () => {
    if (!generatedCopy) return;
    setIsDownloadingPdf(true);
    try {
      const payload = buildBriefPdfPayload({
        brandName,
        productName,
        goal,
        generatedCopy,
        selectedCta,
        aiInsights,
        storeInsights,
        selectedDuration,
        selectedStrategyIndex,
        gatewayInsight,
        isNewLaunch,
      });
      const res = await fetch("/api/campaigns/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(
          errData.detail ||
            errData.error ||
            `Brief generation failed with status ${res.status}`,
        );
      }

      const htmlString = await res.text();
      const blob = new Blob([htmlString], { type: "text/html;charset=utf-8" });
      const blobUrl = URL.createObjectURL(blob);

      // Try to open the brief in a new tab. This runs after an `await`, outside
      // the original click gesture, so some browsers block it. Rather than
      // erroring, fall back to a modal with a link the user can click — a real
      // gesture that is never blocked.
      const newTab = window.open(blobUrl, "_blank", "noopener,noreferrer");
      if (!newTab) {
        setPdfFallbackUrl(blobUrl);
      }
    } catch (err) {
      console.error("PDF error:", err);
      toast({
        variant: "danger",
        title: "Couldn't generate the brief",
        description:
          err instanceof Error
            ? err.message
            : "Something went wrong. Please try again.",
      });
    } finally {
      setIsDownloadingPdf(false);
    }
  };

  const handleCopyBrief = () => {
    if (!generatedCopy) return;
    const briefText = buildBriefText({
      generatedCopy,
      selectedCta,
      aiInsights,
      storeInsights,
      goal,
      selectedStrategyIndex,
      selectedDuration,
    });
    navigator.clipboard.writeText(briefText);
    setCopiedField("full-brief");
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleCreateNewBrief = () => {
    resetForm();
    resetMedia();
    setGeneratedCopy(null);
    setGatewayInsight(null);
    setSelectedCta("");
    setRegenerateCount(0);
    setViewState("media");
  };

  if (loadingDraft) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (viewState === "selection") {
    return (
      <PageContainer width="wide">
        <SelectionStep
          onUseStoreProduct={() => router.push("/products")}
          onUploadCustom={() => setViewState("media")}
        />
      </PageContainer>
    );
  }

  if (viewState === "generating") {
    return (
      <PageContainer width="wide">
        <GeneratingState />
      </PageContainer>
    );
  }

  return (
    <PageContainer width="wide" className="pb-24 lg:pb-12">
      {/* items-start lets StepRail's built-in lg:sticky pin while the right column scrolls */}
      <div className="grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start">
        <StepRail activeIndex={STEP_INDEX[viewState]} />

        <div className="min-w-0">
          {/* -- MEDIA -- */}
          {viewState === "media" && (
            <MediaStep
              autoFilledFromStore={autoFilledFromStore}
              onBack={() =>
                autoFilledFromStore
                  ? setViewState("input")
                  : setViewState("selection")
              }
              fileInputRef={fileInputRef}
              onFileChange={handleMediaSelect}
              isUploading={isUploading}
              mediaPreviewUrl={mediaPreviewUrl}
              mediaFile={mediaFile}
              mediaCloudUrl={mediaCloudUrl}
              uploadError={uploadError}
              mediaValidation={mediaValidation}
              onContinue={() => setViewState("input")}
            />
          )}

          {/* -- INPUT -- */}
          {viewState === "input" && (
            <InputStep
              autoFilledFromStore={autoFilledFromStore}
              onBack={() =>
                autoFilledFromStore
                  ? handleStartOver("selection")
                  : setViewState("media")
              }
              onChangeCreative={() => setViewState("media")}
              mediaPreviewUrl={mediaPreviewUrl}
              mediaFile={mediaFile}
              productPrice={productPrice}
              productVariants={productVariants}
              storeInsights={storeInsights}
              brandName={brandName}
              onBrandNameChange={setBrandName}
              productName={productName}
              onProductNameChange={setProductName}
              description={description}
              onDescriptionChange={setDescription}
              goal={goal}
              onGoalChange={setGoal}
              tone={tone}
              onToneChange={setTone}
              errorMsg={errorMsg}
              showBuyCredits={showBuyCredits}
              onGenerate={() => handleGenerate(false)}
            />
          )}

          {/* -- REVIEW -- */}
          {viewState === "review" && generatedCopy && (
            <ReviewStep
              generatedCopy={generatedCopy}
              previewPlatform={previewPlatform}
              onPlatformChange={setPreviewPlatform}
              brandName={brandName}
              mediaCloudUrl={mediaCloudUrl}
              isVideo={isVideo}
              selectedCta={selectedCta}
              onSelectCta={setSelectedCta}
              resolvedStoreDomain={resolvedStoreDomain}
              copiedField={copiedField}
              onCopy={handleCopy}
              regenerateCount={regenerateCount}
              onUploadDifferent={() => setViewState("media")}
              onRegenerate={() => handleGenerate(true)}
              onStartOver={handleStartOver}
              onGenerateBrief={() => setViewState("brief")}
            />
          )}

          {/* -- BRIEF -- */}
          {viewState === "brief" && generatedCopy && (
            <BriefStep
              generatedCopy={generatedCopy}
              copiedField={copiedField}
              onCopy={handleCopy}
              selectedCta={selectedCta}
              storeInsights={storeInsights}
              aiInsights={aiInsights}
              loadingAiInsights={loadingAiInsights}
              goal={goal}
              selectedStrategyIndex={selectedStrategyIndex}
              setSelectedStrategyIndex={setSelectedStrategyIndex}
              selectedDuration={selectedDuration}
              setSelectedDuration={setSelectedDuration}
              isDownloadingPdf={isDownloadingPdf}
              onDownloadPdf={handleDownloadPdf}
              onCopyBrief={handleCopyBrief}
              onCreateNew={handleCreateNewBrief}
            />
          )}
        </div>
      </div>

      {/* Pop-up-blocked fallback: open the generated brief via a user click. */}
      <Dialog
        open={!!pdfFallbackUrl}
        onOpenChange={(open) => {
          if (!open) {
            if (pdfFallbackUrl) URL.revokeObjectURL(pdfFallbackUrl);
            setPdfFallbackUrl(null);
          }
        }}
        title="Your brief is ready"
        description="Your browser blocked the automatic pop-up. Open your campaign brief in a new tab instead."
        size="sm"
      >
        <Button asChild className="w-full">
          <a
            href={pdfFallbackUrl ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              const url = pdfFallbackUrl;
              // Close the modal but keep the blob alive long enough for the new
              // tab to load before revoking it.
              setPdfFallbackUrl(null);
              if (url) setTimeout(() => URL.revokeObjectURL(url), 2000);
            }}
          >
            <FileText className="size-4" />
            Open brief
          </a>
        </Button>
      </Dialog>
    </PageContainer>
  );
}

export default function CampaignsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[60vh] items-center justify-center">
          <Spinner size="lg" />
        </div>
      }
    >
      <CampaignsContent />
    </Suspense>
  );
}
