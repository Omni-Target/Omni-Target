"use client";

import React, { useState, useEffect, useMemo, Suspense, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useUser } from "@clerk/nextjs";
import { useQueryClient } from "@tanstack/react-query";
import { CREDITS_QUERY_KEY, type CreditsData } from "@/hooks/useCredits";
import { BRIEFS_QUERY_KEY } from "@/components/campaigns/brief-history";
import type { BriefPDFParams } from "@/lib/brief-pdf-types";
import { PageContainer } from "@/components/layout/page-container";
import { Spinner } from "@/components/ui/spinner";

const PdfBriefModal = dynamic(
  () =>
    import("@/components/campaigns/pdf-brief-modal").then(
      (m) => m.PdfBriefModal,
    ),
  { ssr: false },
);
import {
  StepRail,
  SelectionStep,
  GeneratingState,
  type GeneratedCopy,
  type AiInsights,
} from "@/components/campaigns";
import { MediaStep } from "@/components/campaigns/steps/media-step";
import { InputStep } from "@/components/campaigns/steps/input-step";
import { ReviewStep, type BriefVariation } from "@/components/campaigns/steps/review-step";
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
  const queryClient = useQueryClient();
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
  const [modalOpen, setModalOpen] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [selectedCta, setSelectedCta] = useState<string>("");

  const handleReauthRequired = useCallback(
    () => router.replace("/dashboard"),
    [router],
  );
  const { storeInsights, aiInsights, loadingAiInsights } = useStoreInsights({
    onReauthRequired: handleReauthRequired,
    onStoreName: setBrandName,
  });
  const [productAiInsights, setProductAiInsights] = useState<AiInsights | null>(
    null,
  );

  // Once a brief has been generated, `hasGenerated` becomes true. From that
  // point on, creative_hooks, advantage_plus_guidance, and targeting MUST come
  // from `productAiInsights` only — never from the store-level `aiInsights`,
  // which describes the store's top-revenue product (a different SKU).
  const hasGenerated = generatedCopy !== null;

  const effectiveAiInsights: AiInsights | null = useMemo(() => {
    if (!aiInsights && !productAiInsights) return null;

    // After generation, product-specific fields must come ONLY from the
    // per-product API response, not the store-level fallback.
    return {
      ...(aiInsights ?? {}),
      ...(productAiInsights ?? {}),
      creative_hooks: hasGenerated
        ? (productAiInsights?.creative_hooks ?? undefined)
        : (productAiInsights?.creative_hooks ?? aiInsights?.creative_hooks),
      advantage_plus_guidance: hasGenerated
        ? (productAiInsights?.advantage_plus_guidance ?? undefined)
        : (productAiInsights?.advantage_plus_guidance ?? aiInsights?.advantage_plus_guidance),
      timing: productAiInsights?.timing ?? aiInsights?.timing,
    } as AiInsights;
  }, [aiInsights, productAiInsights, hasGenerated]);

  const [gatewayInsight, setGatewayInsight] = useState<
    BriefPDFParams["gatewayInsight"] | null
  >(null);
  const [selectedStrategyIndex, setSelectedStrategyIndex] = useState(1);
  const [selectedIntlStrategyIndex, setSelectedIntlStrategyIndex] = useState(1);
  const [selectedDuration, setSelectedDuration] = useState<7 | 14 | 30>(14);
  const [regenerateCount, setRegenerateCount] = useState(0);
  // Persisted brief session: set on the first generate, reused by regenerations
  // (so attempts append to the same campaign) and by "Generate Brief" to route
  // to the durable /campaigns/[id] page.
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [currentVersionId, setCurrentVersionId] = useState<string | null>(null);
  // Every generation attempt this session, retained so the review step can
  // compare variations; selectedVariationIndex is the one shown/proceeded with.
  const [variations, setVariations] = useState<BriefVariation[]>([]);
  const [selectedVariationIndex, setSelectedVariationIndex] = useState(0);

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
          campaignId,
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
      const newVersionId: string | null = data.versionId ?? null;
      setGeneratedCopy(generatedCopyData);
      setSelectedCta(generatedCopyData.cta);

      // ALWAYS set productAiInsights after generation — even if the targeting
      // profile call failed (returned null). This ensures effectiveAiInsights
      // never falls back to store-level aiInsights (which describes a different
      // product — the store's top-revenue SKU).
      const parsedAiInsights: AiInsights = {
        creative_hooks: data.creative_hooks ?? undefined,
        advantage_plus_guidance: data.advantage_plus_guidance ?? undefined,
        timing: data.targeting_profile?.timing,
        targeting: data.targeting_profile
          ? {
              locations: data.targeting_profile.locations,
              age_min: data.targeting_profile.demographics?.age_min ?? 25,
              age_max: data.targeting_profile.demographics?.age_max ?? 44,
              age_reasoning:
                data.targeting_profile.demographics?.age_reasoning ?? "",
              gender: data.targeting_profile.demographics?.gender ?? "All",
              interests:
                data.targeting_profile.seed_interests ?? ["Online Shopping"],
            }
          : undefined,
      };
      setProductAiInsights(parsedAiInsights);

      // Track the persisted brief so regenerations append to the same session
      // and "Generate Brief" can navigate to the durable /campaigns/[id] page.
      if (data.campaignId) setCampaignId(data.campaignId);
      setCurrentVersionId(newVersionId);

      // Retain every attempt so the review step can compare variations; the
      // freshly generated one becomes the selected/shown variation.
      setVariations((prev) => {
        const entry: BriefVariation = {
          versionId: newVersionId,
          copy: generatedCopyData,
          aiInsights: parsedAiInsights,
        };
        const next = isRegeneration ? [...prev, entry] : [entry];
        setSelectedVariationIndex(next.length - 1);
        return next;
      });

      // Keep the shared credits cache in sync so the top bar + sidebar reflect
      // the new balance instantly, with no refresh. The generate response is
      // authoritative; invalidate afterwards to reconcile in the background.
      if (typeof data.credits_balance === "number") {
        queryClient.setQueryData<CreditsData | undefined>(
          CREDITS_QUERY_KEY,
          (prev) =>
            ({
              ...(prev ?? { unlimited_until: null, shop: null }),
              credits_balance: data.credits_balance,
              is_unlimited: data.is_unlimited ?? prev?.is_unlimited ?? false,
            }) as CreditsData,
        );
      }
      queryClient.invalidateQueries({ queryKey: CREDITS_QUERY_KEY });

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
    setProductAiInsights(null);
    setErrorMsg("");
    setShowBuyCredits(false);
    setRegenerateCount(0);
    setCampaignId(null);
    setCurrentVersionId(null);
    setVariations([]);
    setSelectedVariationIndex(0);
    resetMedia();
    setViewState(finalState);
  };

  // Switch which retained variation is shown; the shown one is what proceeds to
  // the brief (and gets marked selected on finalize).
  const handleSelectVariation = (index: number) => {
    const v = variations[index];
    if (!v) return;
    setSelectedVariationIndex(index);
    setGeneratedCopy(v.copy);
    setCurrentVersionId(v.versionId);
    setSelectedCta(v.copy.cta);
    if (v.aiInsights) {
      setProductAiInsights(v.aiInsights);
    }
  };

  const pdfParams = useMemo(() => {
    if (!generatedCopy) return null;
    return buildBriefPdfPayload({
      brandName,
      productName,
      goal,
      generatedCopy,
      selectedCta,
      aiInsights: effectiveAiInsights,
      storeInsights,
      selectedDuration,
      selectedStrategyIndex,
      selectedIntlStrategyIndex,
      gatewayInsight,
      isNewLaunch,
    });
  }, [
    brandName,
    productName,
    goal,
    generatedCopy,
    selectedCta,
    effectiveAiInsights,
    storeInsights,
    selectedDuration,
    selectedStrategyIndex,
    selectedIntlStrategyIndex,
    gatewayInsight,
    isNewLaunch,
  ]);

  const handleFinalize = async () => {
    setFinalizing(true);
    if (campaignId) {
      try {
        await fetch(`/api/campaigns/${campaignId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            versionId: currentVersionId,
            copy: generatedCopy,
            status: "complete",
            briefData: pdfParams,
          }),
        });
        queryClient.invalidateQueries({ queryKey: BRIEFS_QUERY_KEY });
      } catch (err) {
        console.error("Failed to finalize campaign:", err);
      } finally {
        setFinalizing(false);
      }
    }
    router.push("/dashboard");
  };

  const handleCopyBrief = () => {
    if (!generatedCopy) return;
    const briefText = buildBriefText({
      generatedCopy,
      selectedCta,
      aiInsights: effectiveAiInsights,
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

  const handleCreateNewBrief = () => {
    resetForm();
    resetMedia();
    setGeneratedCopy(null);
    setGatewayInsight(null);
    setSelectedCta("");
    setRegenerateCount(0);
    setCampaignId(null);
    setCurrentVersionId(null);
    setVariations([]);
    setSelectedVariationIndex(0);
    setViewState("media");
  };

  // Persist the chosen variation + brief context, then move the user to the
  // durable brief page. Falls back to the in-app brief view if the brief was
  // never persisted (persistence during generation is best-effort).
  const handleGenerateBrief = async () => {
    if (!campaignId || !generatedCopy) {
      setViewState("brief");
      return;
    }
    try {
      const briefData = {
        brandName,
        productName,
        goal,
        generatedCopy,
        selectedCta,
        aiInsights: effectiveAiInsights,
        creative_hooks: effectiveAiInsights?.creative_hooks,
        advantage_plus_guidance: effectiveAiInsights?.advantage_plus_guidance,
        storeInsights,
        selectedStrategyIndex,
        selectedDuration,
        gatewayInsight,
        isNewLaunch,
      };
      await fetch(`/api/campaigns/${campaignId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versionId: currentVersionId,
          copy: generatedCopy,
          briefData,
        }),
      });
      // The brief is now finalized — refresh the history so it appears there.
      queryClient.invalidateQueries({ queryKey: BRIEFS_QUERY_KEY });
    } catch (err) {
      // Copy is already persisted from generation; brief_data just enriches the
      // page. Navigate regardless so the user always reaches their brief.
      console.error("Failed to finalize brief:", err);
    }
    router.replace(`/campaigns/${campaignId}`);
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
        <GeneratingState productName={productName} brandName={brandName} />
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
              variations={variations}
              selectedVariationIndex={selectedVariationIndex}
              onSelectVariation={handleSelectVariation}
              onUploadDifferent={() => setViewState("media")}
              onRegenerate={() => handleGenerate(true)}
              onStartOver={handleStartOver}
              onGenerateBrief={handleGenerateBrief}
              hooks={
                variations[selectedVariationIndex]?.aiInsights?.creative_hooks ??
                effectiveAiInsights?.creative_hooks
              }
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
              aiInsights={effectiveAiInsights}
              loadingAiInsights={loadingAiInsights}
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
              onCreateNew={handleCreateNewBrief}
              gatewayInsight={gatewayInsight}
            />
          )}
        </div>
      </div>

      {modalOpen && pdfParams && (
        <PdfBriefModal
          open={modalOpen}
          params={pdfParams}
          onFinalize={handleFinalize}
          finalizing={finalizing}
        />
      )}
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
