"use client";

import React, { useState, useEffect, useMemo, Suspense, useRef, useCallback } from "react";
import Link from "next/link";
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
  PENDING_GENERATION_KEY,
  clearPendingGeneration,
  parsePendingGeneration,
  savePendingGeneration,
  type PendingGeneration,
} from "@/lib/campaigns/pending-generation";
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
  const { user, isLoaded: userLoaded } = useUser();
  const queryClient = useQueryClient();
  const storeUrl = (user?.publicMetadata?.shopifyStoreUrl as string) || "";

  const [previewPlatform, setPreviewPlatform] = useState<
    "facebook" | "instagram"
  >("facebook");

  const generatingRef = useRef(false);
  const generationRequestRef = useRef<{ key: string; id: string } | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | undefined>();
  const [viewState, setViewState] = useState<CampaignState>("selection");
  const [loadingDraft, setLoadingDraft] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [showBuyCredits, setShowBuyCredits] = useState(false);
  const [pendingRecovery, setPendingRecovery] = useState<PendingGeneration | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<"checking" | "unconfirmed" | "unavailable">("checking");
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);

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
    gatewayClassification,
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
  const { storeInsights, storeLoading, aiInsights, loadingAiInsights } = useStoreInsights({
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
  const [selectedIntlDuration, setSelectedIntlDuration] = useState<7 | 14 | 30>(14);
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
  const [isFinalizingBrief, setIsFinalizingBrief] = useState(false);
  const [hooksLoading, setHooksLoading] = useState(false);
  const [hooksRetryError, setHooksRetryError] = useState<string | null>(null);
  const [activeGenerationMeta, setActiveGenerationMeta] = useState<{
    productName?: string;
    brandName?: string;
    tone?: string;
    productPrice?: string;
  } | null>(null);

  const [pendingExpressDraft, setPendingExpressDraft] = useState<{
    product_name: string;
    product_description?: string;
    product_price?: string;
    product_variants?: string;
    product_image?: string;
    is_new_launch?: boolean;
    gateway_classification?: string;
    campaign_goal?: string;
    tone_preference?: string;
    express_launch?: boolean;
  } | null>(null);

  // Read from sessionStorage for auto-fill (client-only init from external store)
  useEffect(() => {
    let pendingRaw: string | null;
    let draftStr: string | null;
    try {
      pendingRaw = sessionStorage.getItem(PENDING_GENERATION_KEY);
      draftStr = sessionStorage.getItem("campaign_draft");
    } catch {
      setErrorMsg("Browser session storage is unavailable. Please enable it before generating a brief.");
      setLoadingDraft(false);
      return;
    }
    const pending = parsePendingGeneration(pendingRaw);
    if (pending) {
      setPendingRecovery(pending);
      setLoadingDraft(false);
      return;
    }
    clearPendingGeneration();
    if (draftStr) {
      try {
        const draft = JSON.parse(draftStr);
        if (draft.product_name) {
          const formValues: Partial<CampaignFormState> = {
            productName: draft.product_name,
            autoFilledFromStore: true,
          };
          formValues.description =
            draft.product_description || draft.product_name;
          if (draft.product_price) formValues.productPrice = draft.product_price;
          if (draft.product_variants)
            formValues.productVariants = draft.product_variants;
          if (draft.is_new_launch) formValues.isNewLaunch = true;
          if (draft.gateway_classification) formValues.gatewayClassification = draft.gateway_classification;
          if (draft.campaign_goal) formValues.goal = draft.campaign_goal;
          if (draft.tone_preference) formValues.tone = draft.tone_preference;
          applyDraft(formValues);
          if (draft.product_image) applyDraftImage(draft.product_image);

          if (draft.express_launch) {
            setActiveGenerationMeta({
              productName: draft.product_name,
              tone: draft.tone_preference || "Let AI decide",
              productPrice: draft.product_price,
            });
            setPendingExpressDraft(draft);
            setViewState("generating");
          } else {
            setViewState("input");
          }
          sessionStorage.removeItem("campaign_draft");
        }
      } catch (e) {
        console.error("Failed to parse campaign draft", e);
      }
    }
    setLoadingDraft(false);
  }, [applyDraft, applyDraftImage]);

  // A lost response must be checked against the committed receipt before the
  // browser can start another credit-bearing generation.
  useEffect(() => {
    if (!pendingRecovery || !userLoaded) return;
    if (!user?.id || (pendingRecovery.userId && pendingRecovery.userId !== user.id)) {
      clearPendingGeneration();
      setPendingRecovery(null);
      setViewState("selection");
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const deadline = recoveryAttempt > 0
      ? Date.now()
      : Math.min(pendingRecovery.startedAt + 195_000, Date.now() + 195_000);
    setRecoveryStatus("checking");

    const checkReceipt = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 15_000);
      try {
        const response = await fetch(
          `/api/campaigns/generate/receipt?requestId=${encodeURIComponent(pendingRecovery.requestId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (cancelled) return;
        if (response.status === 202) {
          if (Date.now() < deadline) {
            timer = setTimeout(checkReceipt, 5_000);
          } else {
            setRecoveryStatus("unconfirmed");
          }
          return;
        }
        if (!response.ok) {
          setRecoveryStatus("unavailable");
          return;
        }
        const { receipt } = await response.json();
        if (cancelled) return;
        const campaignId = receipt?.campaignId;
        const versionId = receipt?.versionId;
        if (typeof campaignId !== "string" || !/^[0-9a-f-]{36}$/i.test(campaignId)) {
          setRecoveryStatus("unavailable");
          return;
        }
        clearPendingGeneration();
        queryClient.invalidateQueries({ queryKey: BRIEFS_QUERY_KEY });
        queryClient.invalidateQueries({ queryKey: CREDITS_QUERY_KEY });
        const versionQuery = typeof versionId === "string" && /^[0-9a-f-]{36}$/i.test(versionId)
          ? `?version=${encodeURIComponent(versionId)}`
          : "";
        router.replace(`/campaigns/${campaignId}${versionQuery}`);
      } catch {
        if (!cancelled) setRecoveryStatus("unavailable");
      } finally {
        clearTimeout(timeout);
      }
    };

    void checkReceipt();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [pendingRecovery, recoveryAttempt, userLoaded, user?.id, queryClient, router]);

  // Clear the recovery marker only after the saved result is visible in Review.
  useEffect(() => {
    if (viewState === "review" && campaignId && !pendingRecovery) {
      clearPendingGeneration();
    }
  }, [viewState, campaignId, pendingRecovery]);

  // The draft can load before the shared store query on a cold navigation.
  useEffect(() => {
    if (!pendingExpressDraft || loadingDraft || storeLoading) return;
    if (!storeInsights) {
      setPendingExpressDraft(null);
      setErrorMsg("Store data could not be loaded. Check your connection and try again.");
      setViewState("input");
      return;
    }
    const draft = pendingExpressDraft;
    setPendingExpressDraft(null);
    handleGenerate(false, {
      brandName: storeInsights.store?.name || brandName,
      productName: draft.product_name,
      description: draft.product_description || draft.product_name,
      goal: draft.campaign_goal || "Drive Website Sales",
      tone: draft.tone_preference || "Let AI decide",
      productPrice: draft.product_price,
      productVariants: draft.product_variants,
      imageUrl: draft.product_image,
      isNewLaunch: !!draft.is_new_launch,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingExpressDraft, loadingDraft, storeLoading, storeInsights]);

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

  const handleGenerate = async (
    isRegeneration = false,
    overrides?: {
      brandName?: string;
      productName?: string;
      description?: string;
      goal?: string;
      tone?: string;
      productPrice?: string;
      productVariants?: string;
      imageUrl?: string;
      isNewLaunch?: boolean;
    },
  ) => {
    // Guard against double-submission, including same-tick double-clicks that a
    // state-based check would miss (state updates are async). A ref flips
    // synchronously so the second call returns immediately.
    if (generatingRef.current) return;

    const activeBrandName = overrides?.brandName ?? brandName;
    const activeProductName = overrides?.productName ?? productName;
    const activeDescription = overrides?.description ?? description;
    const activeGoal = overrides?.goal ?? goal;
    const activeTone = overrides?.tone ?? tone;
    const activeProductPrice = overrides?.productPrice ?? productPrice;
    const activeProductVariants = overrides?.productVariants ?? productVariants;
    const activeImageUrl =
      overrides?.imageUrl ?? mediaCloudUrl ?? mediaPreviewUrl ?? null;
    const activeIsNewLaunch = overrides?.isNewLaunch ?? isNewLaunch;

    const errors = validateCampaignForm({
      brandName: activeBrandName,
      productName: activeProductName,
      description: activeDescription,
    });
    if (errors.length > 0) {
      setErrorMsg(errors.join(". "));
      if (isRegeneration || generatedCopy || variations.length > 0) {
        setViewState("review");
      } else {
        setViewState("input");
      }
      return;
    }

    generatingRef.current = true;
    setActiveGenerationMeta({
      productName: activeProductName,
      brandName: activeBrandName,
      tone: activeTone,
      productPrice: activeProductPrice,
    });
    setViewState("generating");
    setErrorMsg("");
    setShowBuyCredits(false);
    setHooksRetryError(null);

    let pendingRequest: PendingGeneration | null = null;
    let responseConfirmed = false;
    try {
      const {
        gatewayInsight: derivedGatewayInsight,
        storeDataForApi,
        storePrices,
      } = buildGenerationContext(storeInsights, activeProductName);
      if (derivedGatewayInsight) setGatewayInsight(derivedGatewayInsight);

      const requestKey = JSON.stringify([
        activeBrandName,
        activeProductName,
        activeDescription,
        activeGoal,
        activeTone,
        activeProductPrice,
        activeImageUrl,
        campaignId,
        isRegeneration,
      ]);
      if (generationRequestRef.current?.key !== requestKey) {
        generationRequestRef.current = { key: requestKey, id: crypto.randomUUID() };
      }
      pendingRequest = {
        requestId: generationRequestRef.current.id,
        userId: user?.id ?? null,
        campaignId,
        startedAt: Date.now(),
      };
      if (!savePendingGeneration(pendingRequest)) {
        responseConfirmed = true;
        throw new Error("Browser session storage is unavailable. Please enable it before generating a brief.");
      }
      const res = await fetch("/api/campaigns/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandName: activeBrandName,
          productName: activeProductName,
          productDescription: activeDescription,
          campaignGoal: activeGoal,
          tonePreference: activeTone,
          mediaUrl: activeImageUrl,
          imageUrl: activeImageUrl,
          productPrice: activeProductPrice || null,
          storeAov: storeInsights?.orders?.average_order_value ?? null,
          storePrices,
          productVariants: activeProductVariants || null,
          gatewayInsight: derivedGatewayInsight,
          storeDataForApi,
          isNewLaunch: activeIsNewLaunch,
          campaignId,
          isRegeneration,
          shopifyStoreCountry: storeInsights?.store?.country || null,
          topCustomerLocations: storeInsights?.orders?.top_locations || null,
          requestId: generationRequestRef.current.id,
        }),
      });

      const data = await res.json();

      if (res.status === 402 || data.error === "no_credits") {
        responseConfirmed = true;
        clearPendingGeneration();
        setErrorMsg(
          "You have no briefs remaining. Purchase a pack to continue.",
        );
        setShowBuyCredits(true);
        if (isRegeneration || generatedCopy || variations.length > 0) {
          setViewState("review");
        } else {
          setViewState("input");
        }
        return;
      }

      if (!res.ok) {
        if (res.status < 500) {
          responseConfirmed = true;
          clearPendingGeneration();
        }
        const errorDetail =
          typeof data.error === "object"
            ? data.error.message || JSON.stringify(data.error)
            : data.error;
        throw new Error(errorDetail || "API returned an error");
      }

      responseConfirmed = true;
      generationRequestRef.current = null;
      setGeneratedAt(data.briefData?.generatedAt);
      setProductAiInsights(data.aiInsights);
      const generatedCopyData: GeneratedCopy = data;
      const newVersionId: string | null = data.versionId ?? null;
      setGeneratedCopy(generatedCopyData);
      setTone(activeTone);
      setSelectedCta(generatedCopyData.cta);

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
          tone: activeTone,
          aiInsights: data.aiInsights,
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
      queryClient.invalidateQueries({ queryKey: BRIEFS_QUERY_KEY });

      if (isRegeneration) setRegenerateCount((prev) => prev + 1);

      setViewState("review");
      setHooksLoading(false);
    } catch (err) {
      console.error(err);
      if (!responseConfirmed && pendingRequest) {
        setPendingRecovery(pendingRequest);
        setRecoveryStatus("checking");
        return;
      }
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again.",
      );
      if (isRegeneration || generatedCopy || variations.length > 0) {
        setViewState("review");
      } else {
        setViewState("input");
      }
    } finally {
      generatingRef.current = false;
      setActiveGenerationMeta(null);
    }
  };

  const handleStartOver = (targetState?: CampaignState | React.MouseEvent) => {
    const finalState = typeof targetState === "string" ? targetState : "media";
    clearPendingGeneration();
    setPendingRecovery(null);
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
    setIsFinalizingBrief(false);
    setHooksLoading(false);
    setHooksRetryError(null);
    setActiveGenerationMeta(null);
    generationRequestRef.current = null;
    resetMedia();
    setViewState(finalState);
  };

  // Switch which retained variation is shown; the shown one is what proceeds to
  // the brief (and gets marked selected on finalize).
  const handleSelectVariation = (index: number) => {
    if (hooksLoading) return;
    const v = variations[index];
    if (!v) return;
    setSelectedVariationIndex(index);
    setGeneratedCopy(v.copy);
    setCurrentVersionId(v.versionId);
    setTone(v.tone);
    setSelectedCta(v.copy.cta);
    setProductAiInsights(v.aiInsights ?? null);
    setHooksRetryError(null);
  };

  const handleRetryHooks = async () => {
    if (hooksLoading || !generatedCopy) return;
    setHooksLoading(true);
    setHooksRetryError(null);
    try {
      const response = await fetch("/api/campaigns/generate/targeting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productName,
          productDescription: description,
          productPrice,
          angleUsed: (generatedCopy as GeneratedCopy & { angleUsed?: string }).angleUsed,
          campaignId: campaignId && currentVersionId ? campaignId : null,
          versionId: campaignId && currentVersionId ? currentVersionId : null,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not generate hooks. Please try again.");
      const hooks = result.creative_hooks as AiInsights["creative_hooks"];
      if (hooks?.length !== 3) {
        throw new Error("Could not generate three verified hooks. Please try again.");
      }
      const updateInsights = (current: AiInsights | null | undefined): AiInsights => ({
        ...(current ?? {}),
        creative_hooks_status: "generated",
        creative_hooks: hooks,
      });
      setProductAiInsights((current) => updateInsights(current));
      setVariations((current) => current.map((variation, index) =>
        index === selectedVariationIndex
          ? { ...variation, aiInsights: updateInsights(variation.aiInsights) }
          : variation
      ));
    } catch (error) {
      setHooksRetryError(error instanceof Error ? error.message : "Could not generate hooks. Please try again.");
    } finally {
      setHooksLoading(false);
    }
  };

  const pdfParams = useMemo(() => {
    if (!generatedCopy) return null;
    return buildBriefPdfPayload({
      brandName,
      productName,
      generatedAt,
      productPrice: productPrice ? parseFloat(productPrice) : undefined,
      goal,
      generatedCopy,
      selectedCta,
      aiInsights: effectiveAiInsights,
      storeInsights,
      selectedDuration,
      selectedIntlDuration,
      selectedStrategyIndex,
      selectedIntlStrategyIndex,
      gatewayInsight,
      isNewLaunch,
    });
  }, [
    brandName,
    productName,
    generatedAt,
    productPrice,
    goal,
    generatedCopy,
    selectedCta,
    effectiveAiInsights,
    storeInsights,
    selectedDuration,
    selectedIntlDuration,
    selectedStrategyIndex,
    selectedIntlStrategyIndex,
    gatewayInsight,
    isNewLaunch,
  ]);

  const handleFinalize = async () => {
    setFinalizing(true);
    if (campaignId) {
      try {
        const saveResponse = await fetch(`/api/campaigns/${campaignId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            versionId: currentVersionId,
            copy: generatedCopy,
            status: "complete",
            briefData: {
              brandName, productName, productPrice: productPrice ? Number(productPrice) : undefined,
              goal, generatedCopy, selectedCta, aiInsights: effectiveAiInsights, storeInsights,
              selectedStrategyIndex, selectedIntlStrategyIndex, selectedDuration, selectedIntlDuration, gatewayInsight, isNewLaunch, generatedAt,
            },
          }),
        });
        if (!saveResponse.ok) throw new Error("Your brief could not be saved. Please retry.");
        queryClient.invalidateQueries({ queryKey: BRIEFS_QUERY_KEY });
      } catch (err) {
        setErrorMsg("Your brief could not be saved. Please retry.");
        return;
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
      selectedIntlStrategyIndex,
      selectedDuration,
      selectedIntlDuration,
      gatewayInsight,
    });
    navigator.clipboard.writeText(briefText);
    setCopiedField("full-brief");
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleCreateNewBrief = () => {
    clearPendingGeneration();
    generationRequestRef.current = null;
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
    setIsFinalizingBrief(false);
    setHooksLoading(false);
    setViewState("media");
  };

  // Persist the chosen variation + brief context, then move the user to the
  // durable brief page. Falls back to the in-app brief view if the brief was
  // never persisted (persistence during generation is best-effort).
  const handleGenerateBrief = async () => {
    if (!campaignId || !generatedCopy) {
      setErrorMsg("Your saved brief could not be confirmed. Please try again.");
      return;
    }
    const targetVersionId =
      currentVersionId || variations[selectedVariationIndex]?.versionId || null;
    if (!targetVersionId) {
      setErrorMsg("The selected variation could not be found. Please try again.");
      return;
    }
    setIsFinalizingBrief(true);
    setErrorMsg("");
    try {
      const briefData = {
        generatedAt,
        productPrice: productPrice ? Number(productPrice) : undefined,
        selectedIntlStrategyIndex,
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
        selectedIntlDuration,
        gatewayInsight,
        isNewLaunch,
      };
      const saveResponse = await fetch(`/api/campaigns/${campaignId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versionId: targetVersionId,
          copy: generatedCopy,
          briefData,
        }),
      });
      if (!saveResponse.ok) {
        throw new Error("Your chosen variation could not be saved. Please retry.");
      }
      queryClient.invalidateQueries({ queryKey: BRIEFS_QUERY_KEY });
    } catch (err) {
      console.warn("Brief finalize PUT failed:", err);
      setErrorMsg("Your chosen variation could not be saved. Please retry.");
      return;
    } finally {
      setIsFinalizingBrief(false);
    }
    router.replace(`/campaigns/${campaignId}`);
  };

  if (loadingDraft || (pendingExpressDraft && storeLoading)) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (pendingRecovery) {
    return (
      <PageContainer width="wide">
        <div className="mx-auto mt-16 max-w-lg rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
          {recoveryStatus === "checking" && <div className="mb-4 flex justify-center"><Spinner size="lg" /></div>}
          <h1 className="text-xl font-semibold text-foreground">Checking your last brief</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {recoveryStatus === "checking"
              ? "Your previous request may still be finishing. We are checking its saved result before another brief can start. This check does not use a credit."
              : recoveryStatus === "unconfirmed"
                ? "There is no saved result yet. The request may still be finishing. Check again or look for it in your saved briefs."
                : "We could not check the save status right now. Your request is still protected from an accidental repeat."}
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            {recoveryStatus !== "checking" && (
              <button type="button" onClick={() => setRecoveryAttempt((value) => value + 1)} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
                Check again
              </button>
            )}
            <Link href={pendingRecovery.campaignId ? `/campaigns/${pendingRecovery.campaignId}` : "/briefs"} className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground hover:bg-surface-subtle">
              Open saved briefs
            </Link>
          </div>
          {recoveryStatus !== "checking" && (
            <div className="mt-6 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">Starting another brief later may use another credit if this one finishes.</p>
              <button type="button" onClick={() => handleStartOver("selection")} className="mt-2 text-sm font-medium text-muted-foreground underline hover:text-foreground">
                Start a new brief
              </button>
            </div>
          )}
        </div>
      </PageContainer>
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
    const displayProductName = activeGenerationMeta?.productName ?? productName;
    const displayBrandName = activeGenerationMeta?.brandName ?? brandName;
    const displayTone = activeGenerationMeta?.tone ?? tone;
    const displayPrice = activeGenerationMeta?.productPrice ?? productPrice;

    return (
      <PageContainer width="wide">
        <GeneratingState
          productName={displayProductName}
          brandName={displayBrandName}
          tonePreference={displayTone}
          productPrice={displayPrice}
          storeCurrency={storeInsights?.store?.currency}
          budgetCalculation={aiInsights?.budget?.calculation}
          isGateway={(
            gatewayInsight?.currentProductName?.toLowerCase() === displayProductName.trim().toLowerCase()
              ? gatewayInsight.currentProductClassification
              : gatewayClassification
          )?.toLowerCase() === "gateway"}
          isNewLaunch={isNewLaunch}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer width="wide" className="pb-24 lg:pb-12">
      {errorMsg && viewState !== "input" && viewState !== "review" && (
        <p role="alert" className="mb-4 text-red-600">
          {errorMsg}
        </p>
      )}
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
              key={selectedVariationIndex}
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
              onRegenerate={(newTone) => {
                if (newTone && newTone !== tone) {
                  handleGenerate(true, { tone: newTone });
                } else {
                  handleGenerate(true);
                }
              }}
              onStartOver={handleStartOver}
              onGenerateBrief={handleGenerateBrief}
              isFinalizing={isFinalizingBrief}
              errorMsg={errorMsg}
              hooks={
                variations[selectedVariationIndex]?.aiInsights?.creative_hooks ??
                effectiveAiInsights?.creative_hooks
              }
              hooksLoading={hooksLoading}
              hooksGenerationStatus={variations[selectedVariationIndex]?.aiInsights?.creative_hooks_status ?? variations[selectedVariationIndex]?.aiInsights?.generation_status ?? effectiveAiInsights?.creative_hooks_status ?? effectiveAiInsights?.generation_status}
              onRetryHooks={handleRetryHooks}
              hooksRetryError={hooksRetryError}
              goal={goal}
              tone={tone}
              gatewayClassification={
                gatewayInsight?.currentProductClassification === "Unknown"
                  ? gatewayClassification
                  : gatewayInsight?.currentProductClassification || gatewayClassification
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
              selectedIntlDuration={selectedIntlDuration}
              setSelectedIntlDuration={setSelectedIntlDuration}
              isDownloadingPdf={false}
              onDownloadPdf={() => setModalOpen(true)}
              onCopyBrief={handleCopyBrief}
              onCreateNew={handleCreateNewBrief}
              gatewayInsight={gatewayInsight}
              productPrice={productPrice ? parseFloat(productPrice) : undefined}
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
