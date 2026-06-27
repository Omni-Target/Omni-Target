"use client";

import React, { useState, useEffect, Suspense, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { ArrowLeft, ArrowRight, Sparkles, ImageIcon, RefreshCw, RotateCcw, Info, FileText, Download, Copy, Check, Wand2 } from "lucide-react";
import { MediaValidationResult } from "@/lib/meta-specs";
import type { BriefPDFParams } from "@/lib/generate-brief-pdf";
import { formatCurrency } from "@/lib/currency";
import { PageContainer } from "@/components/layout/page-container";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  StepRail,
  SelectionStep,
  GeneratingState,
  MediaDropzone,
  AdPreview,
  CopyField,
  CtaSelector,
  TargetingSummary,
  BudgetPlanner,
  type GeneratedCopy,
  type AiInsights,
  type StoreInsights,
  type StoreProduct,
} from "@/components/campaigns";

type CampaignState = "selection" | "media" | "input" | "generating" | "review" | "brief";

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
  const storeUrl = (user?.publicMetadata?.shopifyStoreUrl as string) || "";

  const [previewPlatform, setPreviewPlatform] = useState<"facebook" | "instagram">("facebook");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [viewState, setViewState] = useState<CampaignState>("selection");
  const [loadingDraft, setLoadingDraft] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [showBuyCredits, setShowBuyCredits] = useState(false);

  // Media state
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string>("");
  const [mediaCloudUrl, setMediaCloudUrl] = useState<string>("");
  const [mediaValidation, setMediaValidation] = useState<MediaValidationResult | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  const [autoFilledFromStore, setAutoFilledFromStore] = useState(false);

  // Form state
  const [brandName, setBrandName] = useState("");
  const [productName, setProductName] = useState("");
  const [description, setDescription] = useState("");
  const [productPrice, setProductPrice] = useState("");
  const [productVariants, setProductVariants] = useState("");
  const [goal, setGoal] = useState("Drive Website Sales");
  const [tone, setTone] = useState("Let AI decide (recommended)");

  const [generatedCopy, setGeneratedCopy] = useState<GeneratedCopy | null>(null);

  // Review state
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const [selectedCta, setSelectedCta] = useState<string>("");

  const [storeInsights, setStoreInsights] = useState<StoreInsights | null>(null);
  const [aiInsights, setAiInsights] = useState<AiInsights | null>(null);
  const [loadingAiInsights, setLoadingAiInsights] = useState(false);
  const [gatewayInsight, setGatewayInsight] = useState<BriefPDFParams["gatewayInsight"] | null>(null);
  const [selectedStrategyIndex, setSelectedStrategyIndex] = useState(1);
  const [selectedDuration, setSelectedDuration] = useState<7 | 14 | 30>(14);
  const [isNewLaunch, setIsNewLaunch] = useState(false);
  const [regenerateCount, setRegenerateCount] = useState(0);

  // Read from sessionStorage for auto-fill (client-only init from external store)
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    const draftStr = sessionStorage.getItem("campaign_draft");
    if (draftStr) {
      try {
        const draft = JSON.parse(draftStr);
        if (draft.product_name) {
          setProductName(draft.product_name);
          setAutoFilledFromStore(true);
          if (draft.product_description) setDescription(draft.product_description);
          if (draft.product_image) {
            setMediaPreviewUrl(draft.product_image);
            setMediaCloudUrl(draft.product_image);
          }
          if (draft.product_price) setProductPrice(draft.product_price);
          if (draft.product_variants) setProductVariants(draft.product_variants);
          if (draft.is_new_launch) setIsNewLaunch(true);
          setViewState("input");
          sessionStorage.removeItem("campaign_draft");
        }
      } catch (e) {
        console.error("Failed to parse campaign draft", e);
      }
    }
    setLoadingDraft(false);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  const resolvedStoreDomain = storeInsights?.store?.domain
    ? new URL(storeInsights.store.domain.startsWith("http") ? storeInsights.store.domain : `https://${storeInsights.store.domain}`).hostname.replace("www.", "")
    : storeUrl
      ? new URL(storeUrl.startsWith("http") ? storeUrl : `https://${storeUrl}`).hostname.replace("www.", "")
      : "yourstore.com";

  useEffect(() => {
    fetch("/api/store/data", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        // Dead Shopify session — send the user to the dashboard, which owns the
        // reconnect prompt, rather than silently showing placeholder data here.
        if (data.reauthRequired) {
          router.replace("/dashboard");
          return;
        }
        if (data.connected && data.data) {
          setStoreInsights(data.data);
          if (data.data.store?.name) setBrandName(data.data.store.name);
          setLoadingAiInsights(true);
          fetch("/api/store/insights", { cache: "no-store" })
            .then((r) => r.json())
            .then((insights) => {
              if (!insights.error) setAiInsights(insights);
              setLoadingAiInsights(false);
            })
            .catch(() => setLoadingAiInsights(false));
        }
      })
      .catch(() => {});
  }, [router]);

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

  const isVideo =
    (mediaFile?.type.startsWith("video/") ?? false) ||
    (mediaCloudUrl?.match(/\.(mp4|mov|webm)(\?|$)/i) !== null);

  const handleMediaSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setMediaFile(file);
    setUploadError("");
    setMediaValidation(null);

    const localUrl = URL.createObjectURL(file);
    setMediaPreviewUrl(localUrl);

    const isVideoFile = file.type.startsWith("video/");

    setIsUploading(true);
    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentType: file.type }),
      });

      if (!res.ok) {
        const err = await res.json();
        setUploadError(err.error || "Failed to get upload URL. Please try again.");
        setMediaFile(null);
        setMediaPreviewUrl("");
        return;
      }

      const { presignedUrl, publicUrl } = await res.json();

      const uploadRes = await fetch(presignedUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!uploadRes.ok) {
        setUploadError("Failed to upload file. Please try again.");
        setMediaFile(null);
        setMediaPreviewUrl("");
        return;
      }

      setMediaCloudUrl(publicUrl);

      const getMediaDimensions = (): Promise<{ width: number; height: number; duration?: number }> => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Media metadata extraction timed out. Please check if the file format/codec is supported."));
          }, 10000);

          if (isVideoFile) {
            const video = document.createElement("video");
            video.preload = "metadata";
            video.onloadedmetadata = () => {
              clearTimeout(timeout);
              resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
              URL.revokeObjectURL(video.src);
            };
            video.onerror = () => {
              clearTimeout(timeout);
              reject(new Error("Failed to load video metadata. Unsupported codec or corrupted file."));
              URL.revokeObjectURL(video.src);
            };
            video.src = URL.createObjectURL(file);
          } else {
            const img = new window.Image();
            img.onload = () => {
              clearTimeout(timeout);
              resolve({ width: img.width, height: img.height });
              URL.revokeObjectURL(img.src);
            };
            img.onerror = () => {
              clearTimeout(timeout);
              reject(new Error("Failed to load image. Unsupported format or corrupted file."));
              URL.revokeObjectURL(img.src);
            };
            img.src = URL.createObjectURL(file);
          }
        });
      };

      const dimensions = await getMediaDimensions();
      const { validateMetaAdMedia } = await import("@/lib/meta-specs");
      const validation = validateMetaAdMedia({
        width: dimensions.width,
        height: dimensions.height,
        duration: dimensions.duration,
        format: file.type.split("/")[1],
        resourceType: isVideoFile ? "video" : "image",
      });
      setMediaValidation(validation);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed. Please try again.");
      setMediaFile(null);
      setMediaPreviewUrl("");
    } finally {
      setIsUploading(false);
    }
  };

  const handleGenerate = async (isRegeneration = false) => {
    const errors: string[] = [];
    if (!brandName.trim()) errors.push("Brand name is required");
    if (!productName.trim()) errors.push("Product name is required");
    if (!description.trim()) errors.push("Product description is required");

    if (errors.length > 0) {
      setErrorMsg(errors.join(". "));
      return;
    }

    setViewState("generating");
    setErrorMsg("");
    setShowBuyCredits(false);

    let currentGatewayInsight: BriefPDFParams["gatewayInsight"] | null = null;
    let storeDataForApi: { orderVolumeTier: string } | null = null;

    if (storeInsights?.products) {
      const products = storeInsights.products;
      const bestseller = [...products].sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))[0];
      const gatewayProducts = products.filter((p) => p.gateway_classification === "Gateway");
      const topGateway = gatewayProducts.length > 0
        ? [...gatewayProducts].sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))[0]
        : null;

      const normalizeStr = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const normalizedInput = normalizeStr(productName);
      const currentProduct = products.find((p) => normalizeStr(p.name ?? "") === normalizedInput);

      currentGatewayInsight = {
        currentProductClassification: currentProduct?.gateway_classification || "Unknown",
        currentProductName: currentProduct?.name,
        currentProductImage: currentProduct?.image_url,
        bestsellerName: bestseller?.name,
        topGatewayName: topGateway?.name,
        isBestsellerGateway: bestseller?.id === topGateway?.id,
        currentProductVelocity: currentProduct?.order_velocity,
        currentProductRepeatRate: currentProduct?.repeat_purchase_rate,
        storeAov: storeInsights.orders?.average_order_value,
        storeBaseFtb: products.reduce((acc, p) => acc + (p.first_time_buyer_ratio || 0), 0) / products.length,
      } as BriefPDFParams["gatewayInsight"];

      setGatewayInsight(currentGatewayInsight);

      storeDataForApi = {
        orderVolumeTier:
          (storeInsights.orders?.orders_last_30_days ?? 0) > 200
            ? "High"
            : (storeInsights.orders?.orders_last_30_days ?? 0) > 50
              ? "Medium"
              : "Low",
      };
    }

    const storePrices: number[] = (storeInsights?.products ?? [])
      .map((p) => Number(p.price))
      .filter((p) => p > 0);

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
          gatewayInsight: currentGatewayInsight,
          storeDataForApi,
          isNewLaunch,
          isRegeneration,
          shopifyStoreCountry: storeInsights?.store?.country || null,
          topCustomerLocations: storeInsights?.orders?.top_locations || null,
        }),
      });

      const data = await res.json();

      if (res.status === 402 || data.error === "no_credits") {
        setErrorMsg("You have no briefs remaining. Purchase a pack to continue.");
        setShowBuyCredits(true);
        setViewState("input");
        return;
      }

      if (!res.ok) {
        const errorDetail = typeof data.error === "object" ? (data.error.message || JSON.stringify(data.error)) : data.error;
        throw new Error(errorDetail || "API returned an error");
      }

      const generatedCopyData: GeneratedCopy = data;
      setGeneratedCopy(generatedCopyData);
      setSelectedCta(generatedCopyData.cta);
      if (isRegeneration) setRegenerateCount((prev) => prev + 1);
      setViewState("review");
    } catch (err) {
      console.error(err);
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setViewState("input");
    }
  };

  const handleStartOver = (targetState?: CampaignState | React.MouseEvent) => {
    const finalState = typeof targetState === "string" ? targetState : "media";
    setBrandName("");
    setProductName("");
    setDescription("");
    setGoal("Drive Website Sales");
    setTone("Let AI decide (recommended)");
    setGeneratedCopy(null);
    setErrorMsg("");
    setShowBuyCredits(false);
    setAutoFilledFromStore(false);
    setRegenerateCount(0);
    setMediaPreviewUrl("");
    setMediaCloudUrl("");
    setMediaFile(null);
    setMediaValidation(null);
    setViewState(finalState);
  };

  const handleDownloadPdf = async () => {
    if (!generatedCopy) return;
    setIsDownloadingPdf(true);
    try {
      let productUrl: string | undefined = undefined;
      if (storeInsights?.store?.domain) {
        const cp = storeInsights.products?.find((p) => p.name === productName);
        if (cp?.handle) {
          productUrl = `https://${storeInsights.store.domain}/products/${cp.handle}`;
        }
      }

      const payload: BriefPDFParams = {
        brandName,
        productName,
        productUrl,
        campaignGoal: goal,
        copy: {
          headline: generatedCopy.headline,
          primaryText: generatedCopy.primaryText,
          description: generatedCopy.description,
          cta: selectedCta || generatedCopy.cta,
          copywriterNote: generatedCopy.copywriterNote,
        },
        targeting: aiInsights?.targeting ?? {},
        budget: {
          ...(aiInsights?.budget ?? {}),
          recommended_duration_days: selectedDuration,
          recommended_daily: aiInsights?.budget?.strategies?.[selectedStrategyIndex]?.daily ?? aiInsights?.budget?.recommended_daily,
          goal_adjusted_daily: aiInsights?.budget
            ? Math.round((aiInsights.budget.strategies?.[selectedStrategyIndex]?.daily ?? aiInsights.budget.recommended_daily ?? 0) * (aiInsights.budget.ad_sets || 1) * (aiInsights.budget.breakdown?.goal_multipliers?.[goal] ?? 1))
            : undefined,
          goal_label: (aiInsights?.budget?.breakdown?.goal_multipliers?.[goal] ?? 1) !== 1 ? goal.toLowerCase() : undefined,
          tier: aiInsights?.budget?.strategies?.[selectedStrategyIndex]?.label ?? aiInsights?.budget?.tier,
          reasoning:
            typeof window !== "undefined" && aiInsights?.budget
              ? (() => {
                  const strategies = aiInsights.budget.strategies || [];
                  const currentStrategy = strategies[selectedStrategyIndex] || strategies[1];
                  const baseDaily = currentStrategy.daily;
                  const goalMult = aiInsights.budget.breakdown?.goal_multipliers?.[goal] ?? 1;
                  const adjustedPerAdSet = Math.round(baseDaily * goalMult);
                  const originalDaily = aiInsights.budget.recommended_daily;
                  let res = aiInsights.budget.reasoning;
                  if (originalDaily && originalDaily !== adjustedPerAdSet) {
                    const curr = aiInsights.budget.currency;
                    const oldStr = formatCurrency(originalDaily, curr, aiInsights.budget.currency_symbol);
                    const newStr = formatCurrency(adjustedPerAdSet, curr, aiInsights.budget.currency_symbol);
                    res = res.replace(oldStr, newStr);
                  }
                  return res;
                })()
              : aiInsights?.budget?.reasoning,
        } as BriefPDFParams["budget"],
        timing: aiInsights?.timing ?? {},
        warnings: (() => {
          const cp = storeInsights?.products?.find((p) => p.name === productName);
          const descLength = cp?.description?.trim().length ?? 0;
          const tagCount = cp?.tags?.length ?? 0;
          const orderCount = cp?.order_count ?? cp?.units_sold ?? 0;
          const storeOrderCount = storeInsights?.orders?.order_count ?? storeInsights?.orders?.orders_last_30_days ?? 0;
          const w = [...(aiInsights?.warnings ?? [])];
          if (descLength < 30 || tagCount < 2 || orderCount < 5 || storeOrderCount < 20) {
            const warningMsg = "Limited product data detected — review interests before launching.";
            if (!w.includes(warningMsg)) w.push(warningMsg);
          }
          return w;
        })(),
        generatedAt: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
        gatewayInsight: gatewayInsight ?? undefined,
        isNewLaunch,
      };
      const res = await fetch("/api/campaigns/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || errData.error || `Brief generation failed with status ${res.status}`);
      }

      const htmlString = await res.text();
      const printWindow = window.open("", "_blank");
      if (!printWindow) {
        throw new Error("Pop-up blocked. Please allow pop-ups for this site and try again.");
      }
      const blob = new Blob([htmlString], { type: "text/html;charset=utf-8" });
      const blobUrl = URL.createObjectURL(blob);
      printWindow.location.href = blobUrl;
    } catch (err) {
      console.error("PDF error:", err);
      alert(`Could not generate PDF.\n\nError: ${err instanceof Error ? err.message : String(err)}\n\nPlease try again.`);
    } finally {
      setIsDownloadingPdf(false);
    }
  };

  const handleCopyBrief = () => {
    if (!generatedCopy) return;
    const briefText = [
      "═══ CAMPAIGN BRIEF ═══",
      "",
      "HEADLINE:",
      generatedCopy.headline,
      "",
      "PRIMARY TEXT:",
      generatedCopy.primaryText,
      "",
      "DESCRIPTION:",
      generatedCopy.description,
      "",
      "CTA: " + (selectedCta || generatedCopy.cta),
      "",
      "── TARGETING ──",
      aiInsights?.targeting?.locations && aiInsights.targeting.locations.length > 0
        ? `Locations: ${aiInsights.targeting.locations.map((l) => l.name).join(", ")}`
        : "Locations: Set manually",
      `Age: ${aiInsights?.targeting?.age_min || 25} — ${aiInsights?.targeting?.age_max || 44}`,
      `Gender: ${aiInsights?.targeting?.gender || "All"}`,
      `Interests: ${aiInsights?.targeting?.interests?.join(", ") || "Set manually"}`,
      `Behaviours: ${(aiInsights?.targeting?.behaviours || ["Engaged Shoppers"]).join(", ")}`,
      "",
      "── BUDGET ──",
      aiInsights?.budget
        ? (() => {
            const strategies = aiInsights.budget.strategies || [];
            const currentS = strategies[selectedStrategyIndex] || strategies[1];
            const adSets = aiInsights.budget.ad_sets || 1;
            const gm = aiInsights.budget.breakdown?.goal_multipliers?.[goal] ?? 1;
            const adj = Math.round(currentS.daily * adSets * gm);
            const curr = aiInsights.budget.currency;
            return [
              `Strategy: ${currentS.label}`,
              `Optimization Event: ${aiInsights.budget.optimization_event?.event || "Purchase"}`,
              `Ad Sets: ${adSets}`,
              `Recommended Daily: ${formatCurrency(adj, curr, aiInsights.budget.currency_symbol)}/day`,
              `Test Duration: ${selectedDuration} days`,
              `Total Test Spend: ${formatCurrency(adj * selectedDuration, curr, aiInsights.budget.currency_symbol)}`,
              `Meta Context: ${aiInsights.budget.reasoning}`,
            ].filter(Boolean).join("\n");
          })()
        : `Recommended starting budget: ${formatCurrency(5000, storeInsights?.store?.currency || "USD", storeInsights?.store?.currency_symbol)}/day for 14 days`,
      aiInsights?.budget?.reasoning || "Set final budget in Meta Ads Manager",
      "",
      "── TIMING ──",
      storeInsights?.orders?.peak_days && storeInsights.orders.peak_days.length > 0
        ? `Best days: ${storeInsights.orders.peak_days.join(", ")}`
        : "No timing data yet",
      "",
      "Generated by Omni Target",
    ].join("\n");
    navigator.clipboard.writeText(briefText);
    setCopiedField("full-brief");
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleCreateNewBrief = () => {
    setBrandName("");
    setProductName("");
    setDescription("");
    setGoal("Drive Website Sales");
    setTone("Let AI decide (recommended)");
    setAutoFilledFromStore(false);
    setMediaFile(null);
    setMediaPreviewUrl("");
    setMediaCloudUrl("");
    setMediaValidation(null);
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
            <div className="mx-auto max-w-2xl">
              <button
                onClick={() => (autoFilledFromStore ? setViewState("input") : setViewState("selection"))}
                className="mb-6 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" />
                {autoFilledFromStore ? "Back to campaign details (keep catalog image)" : "Back to options"}
              </button>
              <div className="mb-8">
                <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground sm:text-3xl">
                  Upload ad creative
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  Start by uploading your image or video. We&apos;ll validate it against Meta&apos;s ad specs automatically.
                </p>
              </div>

              <MediaDropzone
                inputRef={fileInputRef}
                onFileChange={handleMediaSelect}
                isUploading={isUploading}
                mediaPreviewUrl={mediaPreviewUrl}
                mediaFile={mediaFile}
                autoFilledFromStore={autoFilledFromStore}
                uploadError={uploadError}
                mediaValidation={mediaValidation}
              />

              <div className="mt-8 flex flex-col gap-3">
                <Button
                  size="lg"
                  onClick={() => setViewState("input")}
                  disabled={isUploading || !mediaCloudUrl || (mediaValidation ? !mediaValidation.isValid : false)}
                >
                  Continue to ad copy
                  <ArrowRight className="size-4" />
                </Button>
                <button
                  onClick={() => setViewState("input")}
                  className="text-center text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  Skip for now — add creative later
                </button>
              </div>
            </div>
          )}

          {/* -- INPUT -- */}
          {viewState === "input" && (
            <div className="mx-auto max-w-2xl">
              <button
                onClick={() => (autoFilledFromStore ? handleStartOver("selection") : setViewState("media"))}
                className="mb-6 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" />
                {autoFilledFromStore ? "Change product / ad type" : "Back to creative"}
              </button>

              <div className="mb-6">
                <Badge variant="brand" className="mb-3">
                  <Sparkles className="size-3" /> Campaign brief
                </Badge>
                <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground sm:text-3xl">
                  Create a campaign brief
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  Describe your product. We&apos;ll generate ad copy and a complete targeting brief based on your store data.
                </p>
              </div>

              {autoFilledFromStore && (
                <Alert variant="success" className="mb-6">
                  <p className="font-medium">Product loaded from your store. Review the details below.</p>
                  <div className="mt-1 flex flex-wrap gap-4 text-current/80">
                    {productPrice && <span>Price: {formatCurrency(parseFloat(productPrice), storeInsights?.store?.currency || "USD")}</span>}
                    {productVariants && <span>Variants: {productVariants.split(",").slice(0, 3).join(", ")}</span>}
                  </div>
                </Alert>
              )}

              {/* Creative summary */}
              <Card className="mb-6 p-4">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint-foreground">Ad creative</p>
                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                  <div className="flex items-center gap-4">
                    {mediaPreviewUrl ? (
                      <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-xl bg-slate-100 ring-1 ring-border-subtle">
                        {mediaFile?.type?.startsWith("video/") || mediaPreviewUrl.includes(".mp4") || mediaPreviewUrl.includes(".mov") ? (
                          <ImageIcon className="size-5 text-brand-500" />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={mediaPreviewUrl} alt="Ad creative" className="size-full object-cover" />
                        )}
                      </div>
                    ) : (
                      <div className="grid size-16 shrink-0 place-items-center rounded-xl border border-dashed border-border text-faint-foreground">
                        <ImageIcon className="size-5" />
                      </div>
                    )}
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">
                          {mediaFile ? "Custom creative uploaded" : autoFilledFromStore ? "Shopify catalog image" : "Custom ad creative"}
                        </span>
                        {mediaFile && <Badge variant="brand" size="sm">Custom</Badge>}
                      </div>
                      <p className="mt-0.5 text-xs text-subtle-foreground">
                        {mediaFile ? (mediaFile.type.startsWith("video/") ? "Custom video ad file" : "Custom image file") : autoFilledFromStore ? "Automatically synced from Shopify catalog" : "Upload an image or video for this campaign"}
                      </p>
                    </div>
                  </div>
                  <Button variant="subtle" size="sm" onClick={() => setViewState("media")} className="shrink-0">
                    {autoFilledFromStore && !mediaFile ? "Use custom upload" : "Change creative"}
                  </Button>
                </div>
              </Card>

              <div className="space-y-5">
                <Field label={<>Brand name <span className="text-danger-500">*</span></>} htmlFor="brandName">
                  <Input id="brandName" value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="Your Brand" />
                </Field>

                <Field label={<>Product name <span className="text-danger-500">*</span></>} htmlFor="productName">
                  <Input
                    id="productName"
                    list="store-products-list"
                    value={productName}
                    onChange={(e) => setProductName(e.target.value)}
                    placeholder="e.g. Adire Maxi Dress"
                  />
                  {storeInsights?.products && storeInsights.products.length > 0 && (
                    <datalist id="store-products-list">
                      {storeInsights.products.map((p: StoreProduct) => (
                        <option key={String(p.id)} value={p.name} />
                      ))}
                    </datalist>
                  )}
                </Field>

                <Field label={<>Product description <span className="text-danger-500">*</span></>} htmlFor="description">
                  <Textarea
                    id="description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe what makes this product special — material, craft, story, feeling"
                    rows={3}
                  />
                </Field>

                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                  <Field label="Campaign goal" htmlFor="goal">
                    <Select id="goal" value={goal} onChange={(e) => setGoal(e.target.value)}>
                      <option>Drive Website Sales</option>
                      <option>Grow Brand Awareness</option>
                      <option>Promote a New Collection</option>
                      <option>Retarget Past Visitors</option>
                    </Select>
                  </Field>
                  <Field label="Tone preference" htmlFor="tone">
                    <Select id="tone" value={tone} onChange={(e) => setTone(e.target.value)}>
                      <option>Let AI decide (recommended)</option>
                      <option>Premium &amp; Aspirational</option>
                      <option>Bold &amp; Direct</option>
                      <option>Warm &amp; Conversational</option>
                      <option>Minimal &amp; Editorial</option>
                    </Select>
                  </Field>
                </div>
              </div>

              {errorMsg && (
                <div className="mt-5 space-y-3">
                  <Alert variant="danger">{errorMsg}</Alert>
                  {showBuyCredits && (
                    <div className="text-center">
                      <Button asChild>
                        <Link href="/pricing">Buy credits <ArrowRight className="size-4" /></Link>
                      </Button>
                    </div>
                  )}
                </div>
              )}

              <Button size="xl" className="mt-8 w-full" onClick={() => handleGenerate(false)}>
                <Wand2 className="size-4" />
                Generate ad copy &amp; brief
                <ArrowRight className="size-4" />
              </Button>
            </div>
          )}

          {/* -- REVIEW -- */}
          {viewState === "review" && generatedCopy && (
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
                      onPlatformChange={setPreviewPlatform}
                      brandName={brandName}
                      mediaCloudUrl={mediaCloudUrl}
                      isVideo={isVideo}
                      copy={generatedCopy}
                      selectedCta={selectedCta}
                      storeDomain={resolvedStoreDomain}
                    />

                    <Card className="flex h-fit flex-col p-5">
                      <h3 className="mb-4 text-base font-semibold text-foreground">Ad copy details</h3>
                      <div className="flex-1 space-y-5">
                        <CopyField label="Primary text" value={generatedCopy.primaryText} fieldKey="primaryText" copiedField={copiedField} onCopy={handleCopy} />
                        <CopyField label="Headline" value={generatedCopy.headline} fieldKey="headline" copiedField={copiedField} onCopy={handleCopy} emphasis="strong" />
                        <CopyField label="Link description" value={generatedCopy.description} fieldKey="description" copiedField={copiedField} onCopy={handleCopy} emphasis="muted" />
                      </div>
                      <div className="mt-5">
                        <CtaSelector selectedCta={selectedCta} onSelect={setSelectedCta} />
                      </div>
                    </Card>
                  </div>
                </div>

                <div className="space-y-4 xl:col-span-4">
                  <Card variant="gradient" className="p-5">
                    <div className="mb-3 flex items-center gap-2">
                      <Info className="size-4 text-brand-600" />
                      <h3 className="text-xs font-bold uppercase tracking-widest text-brand-700">Why this approach</h3>
                    </div>
                    <p className="text-sm leading-relaxed text-muted-foreground">{generatedCopy.copywriterNote}</p>
                  </Card>

                  <Card className="p-5">
                    <p className="mb-4 text-center text-xs text-subtle-foreground">Not quite right?</p>
                    <div className="space-y-3">
                      <Button variant="secondary" className="w-full" onClick={() => setViewState("media")}>
                        <ImageIcon className="size-4" /> Upload different creative
                      </Button>
                      {regenerateCount < 3 && (
                        <Button variant="secondary" className="w-full" onClick={() => handleGenerate(true)}>
                          <RefreshCw className="size-4" /> Generate another variation ({3 - regenerateCount} free left)
                        </Button>
                      )}
                      <Button variant="danger-soft" className="w-full" onClick={handleStartOver}>
                        <RotateCcw className="size-4" /> Start over
                      </Button>
                    </div>
                  </Card>
                </div>
              </div>

              <div className="mx-auto mt-8 max-w-3xl">
                <Button size="xl" className="w-full" onClick={() => setViewState("brief")}>
                  <FileText className="size-4" /> Generate campaign brief
                  <ArrowRight className="size-4" />
                </Button>
                <p className="mt-3 text-center text-xs text-subtle-foreground">
                  Your brief will contain everything you need to set up this campaign in Meta Ads Manager.
                </p>
              </div>
            </div>
          )}

          {/* -- BRIEF -- */}
          {viewState === "brief" && generatedCopy && (
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
                  <h3 className="mb-5 text-sm font-semibold uppercase tracking-widest text-subtle-foreground">Ad copy</h3>
                  <div className="space-y-4">
                    <CopyField label="Headline" value={generatedCopy.headline} fieldKey="brief-headline" copiedField={copiedField} onCopy={handleCopy} emphasis="strong" />
                    <CopyField label="Primary text" value={generatedCopy.primaryText} fieldKey="brief-primary" copiedField={copiedField} onCopy={handleCopy} />
                    <CopyField label="Description" value={generatedCopy.description} fieldKey="brief-desc" copiedField={copiedField} onCopy={handleCopy} emphasis="muted" />
                    <CopyField label="Call to action" value={selectedCta || generatedCopy.cta} fieldKey="brief-cta" copiedField={copiedField} onCopy={handleCopy} emphasis="strong" />
                  </div>
                </Card>

                <TargetingSummary storeInsights={storeInsights} aiInsights={aiInsights} loadingAiInsights={loadingAiInsights} />

                <BudgetPlanner
                  aiInsights={aiInsights}
                  goal={goal}
                  selectedStrategyIndex={selectedStrategyIndex}
                  setSelectedStrategyIndex={setSelectedStrategyIndex}
                  selectedDuration={selectedDuration}
                  setSelectedDuration={setSelectedDuration}
                  loadingAiInsights={loadingAiInsights}
                />

                {storeInsights?.orders?.peak_days && storeInsights.orders.peak_days.length > 0 && (
                  <Card className="p-6">
                    <h3 className="mb-5 text-sm font-semibold uppercase tracking-widest text-subtle-foreground">Timing</h3>
                    <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-faint-foreground">Best days to run</span>
                    <p className="mt-1 text-sm text-foreground">{storeInsights.orders.peak_days.join(", ")}</p>
                  </Card>
                )}

                <div className="space-y-3 pt-2">
                  <Button size="xl" className="w-full" isLoading={isDownloadingPdf} onClick={handleDownloadPdf}>
                    {!isDownloadingPdf && <Download className="size-4" />}
                    {isDownloadingPdf ? "Generating premium PDF…" : "Download PDF brief"}
                  </Button>
                  <Button variant="secondary" className="w-full" onClick={handleCopyBrief}>
                    {copiedField === "full-brief" ? <><Check className="size-4" /> Copied</> : <><Copy className="size-4" /> Copy brief to clipboard</>}
                  </Button>
                  <Button variant="ghost" className="w-full" onClick={handleCreateNewBrief}>
                    Create new brief
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
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
