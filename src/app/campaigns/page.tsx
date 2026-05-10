"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { SignOutButton, useUser } from "@clerk/nextjs";
import { MediaValidationResult } from "@/lib/meta-specs";
import { generateBriefPDF } from "@/lib/generate-brief-pdf";
import { formatCurrency, getCurrencySymbol } from "@/lib/currency";

type CampaignState = "media" | "input" | "generating" | "review" | "brief";

interface GeneratedCopy {
  headline: string;
  primaryText: string;
  description: string;
  cta: string;
  copywriterNote: string;
}

function CampaignsContent() {
  const router = useRouter();
  
  const { user } = useUser();
  const storeUrl = user?.publicMetadata?.shopifyStoreUrl as string || "";

  // Extract clean domain for display:
  const storeDomain = storeUrl
    ? new URL(
        storeUrl.startsWith("http") 
          ? storeUrl 
          : `https://${storeUrl}`
      ).hostname.replace("www.", "")
    : "yourstore.com";

  // Overall State
  const [viewState, setViewState] = useState<CampaignState>("media");
  const [errorMsg, setErrorMsg] = useState("");

  // Media State
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string>("");
  const [mediaCloudUrl, setMediaCloudUrl] = useState<string>("");
  const [mediaValidation, setMediaValidation] = useState<MediaValidationResult | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  // URL param auto-fill
  const searchParams = useSearchParams();
  const [autoFilledFromStore, setAutoFilledFromStore] = useState(false);

  const paramProductName = searchParams.get("product_name") || "";
  const paramDescription = searchParams.get("product_description") || "";
  const paramImage = searchParams.get("product_image") || "";
  const paramPrice = searchParams.get("product_price") || "";
  const paramTags = searchParams.get("product_tags") || "";
  const paramType = searchParams.get("product_type") || "";

  // Handle URL params for auto-fill
  useEffect(() => {
    if (paramProductName) {
      setProductName(paramProductName);
      setAutoFilledFromStore(true);
      
      // Build a rich description from 
      // available data
      if (paramDescription) {
        setDescription(paramDescription);
      }
      
      // Pre-fill media from product image
      if (paramImage) {
        setMediaPreviewUrl(paramImage);
        setMediaCloudUrl(paramImage);
        // Skip media upload step
        setViewState("input");
      }
    }
  }, [paramProductName, paramDescription, paramImage]);

  // Form State
  const [brandName, setBrandName] = useState("");
  const [productName, setProductName] = useState("");
  const [description, setDescription] = useState("");
  const [goal, setGoal] = useState("Drive Website Sales");
  const [tone, setTone] = useState("Let AI decide (recommended)");

  // API State
  const [generatedCopy, setGeneratedCopy] = useState<GeneratedCopy | null>(null);

  // Review State
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [selectedCta, setSelectedCta] = useState<string>("");

  // Store Insights for Brief
  const [storeInsights, setStoreInsights] = useState<any>(null);
  const [loadingInsights, setLoadingInsights] = useState(false);
  const [aiInsights, setAiInsights] = useState<any>(null);
  const [loadingAiInsights, setLoadingAiInsights] = useState(false);
  
  const [credits, setCredits] = useState(0);
  const [isUnlimited, setIsUnlimited] = useState(false);

  useEffect(() => {
    setLoadingInsights(true);
    fetch("/api/store/data", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (data.connected && data.data) {
          setStoreInsights(data.data);
          if (data.data.store?.name) {
            setBrandName(data.data.store.name);
          }
          setCredits(data.credits_balance || 0);
          if (data.credits_unlimited_until) {
            const unlimitedDate = new Date(data.credits_unlimited_until);
            if (unlimitedDate > new Date()) {
              setIsUnlimited(true);
            }
          }
          // Fetch AI insights once store data is confirmed
          setLoadingAiInsights(true);
          fetch("/api/store/insights", { cache: "no-store" })
            .then((r) => r.json())
            .then((insights) => {
              if (!insights.error) {
                setAiInsights(insights);
              }
              setLoadingAiInsights(false);
            })
            .catch(() => setLoadingAiInsights(false));
        }
        setLoadingInsights(false);
      })
      .catch(() => setLoadingInsights(false));
  }, []);

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  const isVideo = mediaFile?.type.startsWith("video/") ?? false;

  const handleMediaSelect = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setMediaFile(file);
    setUploadError("");
    setMediaValidation(null);
    
    // Show local preview immediately
    const localUrl = URL.createObjectURL(file);
    setMediaPreviewUrl(localUrl);
    
    // Upload to Cloudinary
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      
      const res = await fetch("/api/media/upload", {
        method: "POST",
        body: formData,
      });
      
      if (!res.ok) {
        const err = await res.json();
        setUploadError(err.error || "Upload failed. Please try again.");
        setMediaFile(null);
        setMediaPreviewUrl("");
        return;
      }
      
      const data = await res.json();
      setMediaCloudUrl(data.url);
      
      // Validate against Meta specs
      const { validateMetaAdMedia } = await import("@/lib/meta-specs");
      const validation = validateMetaAdMedia({
        width: data.width,
        height: data.height,
        duration: data.duration,
        format: data.format,
        resourceType: data.resourceType,
      });
      setMediaValidation(validation);
      
    } catch {
      setUploadError("Upload failed. Please try again.");
      setMediaFile(null);
      setMediaPreviewUrl("");
    } finally {
      setIsUploading(false);
    }
  };

  const handleGenerate = async () => {
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
          imageUrl: mediaCloudUrl || paramImage || null,
          productPrice: paramPrice || null,
        }),
      });

      if (!res.ok) throw new Error("API returned an error");

      const data: GeneratedCopy = await res.json();
      setGeneratedCopy(data);
      setSelectedCta(data.cta);
      
      // Update local credits display
      if (!isUnlimited) {
        setCredits((prev) => Math.max(0, prev - 1));
      }
      
      setViewState("review");
    } catch (err) {
      console.error(err);
      setErrorMsg("Something went wrong. Please try again.");
      setViewState("input");
    }
  };

  const handleStartOver = () => {
    setBrandName("");
    setProductName("");
    setDescription("");
    setGoal("Drive Website Sales");
    setTone("Let AI decide (recommended)");
    setGeneratedCopy(null);
    setErrorMsg("");
    setAutoFilledFromStore(false);
    setMediaPreviewUrl("");
    setMediaCloudUrl("");
    setMediaFile(null);
    setMediaValidation(null);
    setViewState("media");
  };

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)] relative overflow-hidden flex flex-col">
      {/* Top nav bar */}
      <nav className="border-b border-border-subtle bg-surface/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center shadow-lg shadow-brand-500/20 flex-shrink-0">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
              </svg>
            </div>
            <span className="text-sm font-semibold tracking-tight text-white/90">omni-target</span>
          </div>
          <div className="hidden sm:flex items-center justify-center gap-6 absolute left-1/2 -translate-x-1/2">
            <Link href="/dashboard" className="text-sm font-medium text-white/60 hover:text-white/90 transition-colors">Dashboard</Link>
            <Link href="/campaigns" className="text-sm font-medium text-white/90 transition-colors">Campaigns</Link>
            
            {(credits > 0 || isUnlimited) && (
              <span className="text-xs text-white/50">
                {isUnlimited ? "Unlimited" : `${credits} briefs`}
              </span>
            )}
            
            {credits === 0 && !isUnlimited && (
              <Link href="/pricing" className="text-sm font-medium text-brand-400 hover:text-brand-300 transition-colors">Buy Credits</Link>
            )}
            
            <Link href="/settings" className="text-sm font-medium text-white/60 hover:text-white/90 transition-colors">Settings</Link>
          </div>
          <div className="flex items-center gap-6">
            <SignOutButton>
              <button className="text-xs font-medium text-white/40 hover:text-white/80 transition-colors cursor-pointer bg-transparent border-none p-0">
                Sign Out
              </button>
            </SignOutButton>
            {viewState === "review" || viewState === "brief" ? (
              <button 
                onClick={() => setViewState("input")} 
                className="text-white/40 hover:text-white/60 transition-colors flex items-center gap-1.5 cursor-pointer bg-transparent border-none p-0"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
                Edit Campaign
              </button>
            ) : storeInsights ? (
              <div className="flex items-center gap-2 text-xs text-white/40">
                <div className="w-2 h-2 rounded-full bg-success-400 animate-pulse" />
                Store Connected
              </div>
            ) : null}
          </div>
        </div>
      </nav>

      {/* Background orbs */}
      <div className="fixed top-0 left-1/4 w-[500px] h-[500px] bg-brand-600/5 rounded-full blur-[120px] pointer-events-none" />
      <div className={`fixed bottom-0 right-1/4 w-[400px] h-[400px] rounded-full blur-[100px] pointer-events-none transition-colors duration-1000 ${viewState === 'review' ? 'bg-success-500/5' : 'bg-brand-400/5'}`} />

      {/* -- STATE 0: MEDIA -- */}
      {viewState === "media" && (
        <main className="max-w-2xl mx-auto px-4 sm:px-6 py-10 relative flex-1">
          <div className="mb-8 animate-fade-in-up">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-2">
              Upload Ad Creative
            </h1>
            <p className="text-sm text-white/40">
              Start by uploading your image or video. We'll automatically validate it against Meta's ad specs.
            </p>
          </div>

          <div className="mb-8 animate-fade-in-up-delay-1">
            <div className="relative rounded-2xl border-2 border-dashed border-border-subtle hover:border-brand-500/50 transition-colors bg-white/[0.02] overflow-hidden flex flex-col items-center justify-center min-h-[300px] text-center p-6">
              <input 
                type="file" 
                accept="image/jpeg,image/png,video/mp4,video/quicktime"
                onChange={handleMediaSelect}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                disabled={isUploading}
              />
              
              {isUploading ? (
                <div className="flex flex-col items-center gap-3">
                  <svg className="animate-spin h-8 w-8 text-brand-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <p className="text-sm font-medium text-white/70">Uploading...</p>
                </div>
              ) : mediaPreviewUrl ? (
                <div className="w-full h-full flex flex-col items-center">
                  <div className="relative w-full max-w-sm aspect-[4/5] sm:aspect-square mb-4 bg-black/50 rounded-lg overflow-hidden flex items-center justify-center">
                    {mediaFile?.type?.startsWith("video/") ? (
                      <video src={mediaPreviewUrl} controls className="max-w-full max-h-full object-contain" />
                    ) : (
                      <img src={mediaPreviewUrl} alt="Preview" className="max-w-full max-h-full object-contain" />
                    )}
                  </div>
                  <button className="text-xs font-semibold px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors relative z-20 pointer-events-auto cursor-pointer">
                    Change Media
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center pointer-events-none">
                  <div className="w-12 h-12 bg-white/5 rounded-full flex items-center justify-center mb-4 text-white/40">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                  </div>
                  <p className="text-base font-semibold text-white/90 mb-1">
                    Upload your ad creative
                  </p>
                  <p className="text-xs text-white/50">
                    JPG, PNG, MP4 or MOV &middot; Images min 1080px &middot; Videos max 60s
                  </p>
                </div>
              )}
            </div>

            {uploadError && (
              <div className="mt-4 p-3 rounded-lg bg-error-500/10 border border-error-500/20 text-sm text-error-400 flex items-start gap-2">
                <svg className="shrink-0 mt-0.5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                {uploadError}
              </div>
            )}

            {mediaValidation && (
              <div className="mt-4 space-y-3">
                {mediaValidation.errors.length === 0 && mediaValidation.warnings.length === 0 && (
                  <div className="p-3 rounded-lg bg-success-500/10 border border-success-500/20 text-sm text-success-400 flex items-center gap-2">
                    <svg className="shrink-0 mr-2" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    Creative looks great for Meta
                  </div>
                )}
                
                {mediaValidation.errors.map((err, i) => (
                  <div key={`err-${i}`} className="p-3 rounded-lg bg-error-500/10 border border-error-500/20 text-sm text-error-400 flex items-start gap-2">
                    <svg className="shrink-0 mt-0.5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                    {err}
                  </div>
                ))}

                {mediaValidation.warnings.map((warn, i) => (
                  <div key={`warn-${i}`} className="p-3 rounded-lg bg-[#f59e0b]/10 border border-[#f59e0b]/20 text-sm text-[#f59e0b] flex items-start gap-2">
                    <svg className="shrink-0 mt-0.5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    {warn}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-4 animate-fade-in-up-delay-2">
            <button
              onClick={() => setViewState("input")}
              disabled={isUploading || !mediaCloudUrl || (mediaValidation ? !mediaValidation.isValid : false)}
              className="group relative w-full py-4 px-6 rounded-xl font-semibold text-sm transition-all duration-300 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 z-0"
            >
              <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 transition-all duration-300 group-hover:from-brand-500 group-hover:to-brand-400 group-disabled:from-[var(--surface-raised)] group-disabled:to-[var(--surface-raised)]" />
              <span className="relative flex items-center justify-center gap-2 text-white">
                Continue to Ad Copy
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-200 group-disabled:translate-x-0 group-hover:translate-x-1">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </span>
            </button>

            <button 
              onClick={() => setViewState("input")}
              className="text-xs text-center text-white/40 hover:text-white/70 transition-colors font-medium cursor-pointer bg-transparent border-none"
            >
              Skip for now — add creative later
            </button>
          </div>
        </main>
      )}

      {/* -- STATE 1: INPUT FORM -- */}
      {viewState === "input" && (
        <main className="max-w-2xl mx-auto px-4 sm:px-6 py-10 relative flex-1">
          <div className="mb-8 animate-fade-in-up">
            {!autoFilledFromStore && (
              <button 
                onClick={() => setViewState("media")}
                className="flex items-center gap-2 text-xs font-medium text-white/40 hover:text-white/80 transition-colors mb-6 cursor-pointer bg-transparent border-none p-0"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
                Back to Creative
              </button>
            )}

            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-500/10 border border-brand-500/20 mb-4">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-400">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
              <span className="text-xs font-medium text-brand-400">Campaign Brief</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-2">
              Create a Campaign Brief
            </h1>
            <p className="text-sm text-white/40">
              Describe your product. We&apos;ll generate ad copy and a complete targeting brief based on your store data.
            </p>
          </div>

          {/* Auto-fill banner */}
          {autoFilledFromStore && (
            <div className="mb-6 flex flex-col gap-2 px-4 py-3 rounded-xl bg-success-500/10 border border-success-500/20 animate-fade-in-up">
              <div className="flex items-center gap-3 text-sm text-success-400">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>Product loaded from your store. Review the details below.</span>
              </div>
              <div className="flex gap-4 text-sm text-white/60 mt-2">
                {paramPrice && (
                  <span>Price: {formatCurrency(parseFloat(paramPrice), storeInsights?.store?.currency || "USD")}</span>
                )}
                {paramType && (
                  <span>Type: {paramType}</span>
                )}
                {paramTags && (
                  <span>Tags: {paramTags.split(",").slice(0,3).join(", ")}</span>
                )}
              </div>
            </div>
          )}

          <div className="space-y-6 animate-fade-in-up-delay-1 mb-8">
            {/* Brand Name */}
            <div>
              <label htmlFor="brandName" className="block text-xs font-medium text-white/50 uppercase tracking-wider mb-2">
                Brand Name <span className="text-error-400">*</span>
              </label>
              <input
                id="brandName"
                type="text"
                value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
                placeholder="Your Brand"
                className="w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-border-subtle text-sm text-white placeholder:text-white/20 outline-none transition-all duration-200 focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/20"
              />
            </div>

            {/* Product Name */}
            <div>
              <label htmlFor="productName" className="block text-xs font-medium text-white/50 uppercase tracking-wider mb-2">
                Product Name <span className="text-error-400">*</span>
              </label>
              <input
                id="productName"
                type="text"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                placeholder="e.g. Adire Maxi Dress"
                className="w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-border-subtle text-sm text-white placeholder:text-white/20 outline-none transition-all duration-200 focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/20"
              />
            </div>

            {/* Product Description */}
            <div>
              <label htmlFor="description" className="block text-xs font-medium text-white/50 uppercase tracking-wider mb-2">
                Product Description <span className="text-error-400">*</span>
              </label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe what makes this product special — material, craft, story, feeling"
                rows={3}
                className="w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-border-subtle text-sm text-white placeholder:text-white/20 outline-none transition-all duration-200 focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/20 resize-none"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 relative z-10">
              {/* Campaign Goal */}
              <div className="relative">
                <label htmlFor="goal" className="block text-xs font-medium text-white/50 uppercase tracking-wider mb-2">
                  Campaign Goal
                </label>
                <div className="relative">
                  <select
                    id="goal"
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    className="appearance-none w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-border-subtle text-sm text-white outline-none transition-all duration-200 focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/20 cursor-pointer"
                  >
                    <option value="Drive Website Sales" className="bg-[#09090f] text-white">Drive Website Sales</option>
                    <option value="Grow Brand Awareness" className="bg-[#09090f] text-white">Grow Brand Awareness</option>
                    <option value="Promote a New Collection" className="bg-[#09090f] text-white">Promote a New Collection</option>
                    <option value="Retarget Past Visitors" className="bg-[#09090f] text-white">Retarget Past Visitors</option>
                  </select>
                  <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-white/40">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>
                </div>
              </div>

              {/* Tone Preference */}
              <div className="relative">
                <label htmlFor="tone" className="block text-xs font-medium text-white/50 uppercase tracking-wider mb-2">
                  Tone Preference
                </label>
                <div className="relative">
                  <select
                    id="tone"
                    value={tone}
                    onChange={(e) => setTone(e.target.value)}
                    className="appearance-none w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-border-subtle text-sm text-white outline-none transition-all duration-200 focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/20 cursor-pointer"
                  >
                    <option value="Let AI decide (recommended)" className="bg-[#09090f] text-white">Let AI decide (recommended)</option>
                    <option value="Premium & Aspirational" className="bg-[#09090f] text-white">Premium &amp; Aspirational</option>
                    <option value="Bold & Direct" className="bg-[#09090f] text-white">Bold &amp; Direct</option>
                    <option value="Warm & Conversational" className="bg-[#09090f] text-white">Warm &amp; Conversational</option>
                    <option value="Minimal & Editorial" className="bg-[#09090f] text-white">Minimal &amp; Editorial</option>
                  </select>
                  <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-white/40">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>
                </div>
              </div>
            </div>

          </div>

          {errorMsg && (
            <div className="mb-4 p-3 rounded-lg bg-error-500/10 border border-error-500/20 text-sm text-error-400 flex items-center gap-2 animate-fade-in-up">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {errorMsg}
            </div>
          )}

          <button
            id="generate-btn"
            onClick={handleGenerate}
            className="group relative w-full py-4 px-6 rounded-xl font-semibold text-sm transition-all duration-300 animate-fade-in-up-delay-2 cursor-pointer z-0"
          >
            <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 transition-all duration-300 group-hover:from-brand-500 group-hover:to-brand-400" />
            <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-brand-500/20 blur-xl" />
            <span className="relative flex items-center justify-center gap-3 text-white">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
              Generate Ad Copy &amp; Brief →
            </span>
          </button>
        </main>
      )}

      {/* -- STATE 2: GENERATING -- */}
      {viewState === "generating" && (
        <div className="flex-1 flex flex-col items-center justify-center min-h-[60vh]">
          <div className="relative w-20 h-20 mb-8">
            <div className="absolute inset-0 rounded-full border-2 border-brand-500/20 animate-spin" style={{ animationDuration: "3s" }} />
            <div className="absolute inset-2 rounded-full border-[1.5px] border-brand-400/40 animate-spin" style={{ animationDuration: "2s", animationDirection: "reverse" }} />
            <div className="absolute inset-0 flex items-center justify-center animate-pulse">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-400">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </div>
          </div>
          <h2 className="text-xl font-medium text-white/90 animate-pulse tracking-wide">
            Writing your ad copy...
          </h2>
        </div>
      )}

      {/* -- STATE 3: REVIEW -- */}
      {viewState === "review" && generatedCopy && (
        <main className="max-w-4xl mx-auto px-4 sm:px-6 py-10 relative flex-1 w-full">
          <div className="text-center mb-10 animate-fade-in-up">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-success-500/10 border border-success-500/20 mb-4">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-success-400">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span className="text-xs font-medium text-success-400">AI Creatives Ready</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-2">
              Review Generated Copy
            </h1>
            <p className="text-sm text-white/40">
              Review your personalized Meta Ad output below.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-6 mb-10">
            {/* Main Creative Area */}
            <div className="md:col-span-8 animate-fade-in-up-delay-1 space-y-6">
              
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* PART A: Meta Mockup */}
                <div className="flex justify-center">
                  <div className="w-full max-w-[400px] h-fit bg-white rounded-xl shadow-xl overflow-hidden text-black/90 font-sans border border-black/10">
                    {/* Header */}
                    <div className="flex items-center justify-between p-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center font-bold text-slate-500 uppercase overflow-hidden">
                          {brandName.slice(0, 2) || "BR"}
                        </div>
                        <div className="flex flex-col">
                          <span className="text-sm font-semibold">{brandName || "Your Brand"}</span>
                          <span className="text-[11px] text-black/50">Sponsored</span>
                        </div>
                      </div>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-black/40">
                        <path d="M12 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm-7 0c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm14 0c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/>
                      </svg>
                    </div>

                    {/* Media Area */}
                    <div className="w-full aspect-square bg-[#f0f2f5] flex items-center justify-center relative border-y border-black/5 overflow-hidden">
                      {mediaCloudUrl ? (
                        isVideo ? (
                          <video 
                            src={mediaCloudUrl}
                            className="w-full aspect-square object-cover"
                            muted
                            playsInline
                          />
                        ) : (
                          <img 
                            src={mediaCloudUrl}
                            alt="Ad creative"
                            className="w-full aspect-square object-cover"
                          />
                        )
                      ) : (
                        <div className="w-full aspect-square bg-white/5 flex flex-col items-center justify-center gap-2">
                          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white/20">
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <circle cx="8.5" cy="8.5" r="1.5" />
                            <polyline points="21 15 16 10 5 21" />
                          </svg>
                          <span className="text-xs text-white/30">
                            No creative uploaded
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Content Area */}
                    <div className="p-3">
                      {/* Primary Text */}
                      <div className="text-[13.5px] mb-3 leading-snug relative text-black overflow-hidden" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>
                        {generatedCopy.primaryText}
                      </div>

                      <div className="bg-[#f0f2f5] p-3 -mx-3 mb-1 border-t border-black/5">
                        <div className="flex items-center justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <p className="text-[11px] text-black/50 uppercase tracking-widest mb-1 truncate">
                              {storeDomain.toUpperCase()}
                            </p>
                            <h4 className="text-[15px] font-semibold text-black leading-tight mb-0.5 truncate">
                              {generatedCopy.headline}
                            </h4>
                            <p className="text-[13px] text-black/50 truncate">
                              {generatedCopy.description}
                            </p>
                          </div>
                          <div className="shrink-0">
                            <span className="inline-block bg-black/10 px-4 py-1.5 rounded text-[13px] font-semibold text-black border border-black/5">
                              {selectedCta || generatedCopy.cta}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Engagement */}
                    <div className="px-3 pb-3 flex items-center justify-between border-t border-black/5 pt-3">
                      <div className="flex items-center gap-4 text-black/60">
                        <div className="flex items-center gap-1.5">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>
                          <span className="text-sm font-medium">Like</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
                          <span className="text-sm font-medium">Comment</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
                          <span className="text-sm font-medium">Share</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* PART B: Copy Details Panel */}
                <div className="flex flex-col gap-4">
                  <div className="rounded-2xl bg-surface-raised border border-border-subtle p-5 relative overflow-hidden h-fit flex flex-col">
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-brand-500/50 to-brand-400/50" />
                    <h3 className="text-lg font-bold text-white mb-4">Ad Copy Details</h3>
                    
                    <div className="space-y-5 flex-1 w-full relative z-10">
                      {/* Primary Text */}
                      <div className="w-full">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] uppercase tracking-wider text-white/50 font-semibold">Primary Text</span>
                          <button onClick={() => handleCopy(generatedCopy.primaryText, 'primaryText')} className="text-xs text-brand-400 hover:text-brand-300 transition-colors flex items-center gap-1 cursor-pointer bg-transparent border-none p-0">
                            {copiedField === 'primaryText' ? (
                              <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg> Copied!</>
                            ) : (
                              <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg> Copy</>
                            )}
                          </button>
                        </div>
                        <div className="bg-white/[0.02] border border-white/5 rounded-xl p-3 w-full">
                          <p className="text-sm text-white/80 leading-relaxed whitespace-pre-wrap break-words">{generatedCopy.primaryText}</p>
                        </div>
                      </div>

                      {/* Headline */}
                      <div className="w-full">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] uppercase tracking-wider text-white/50 font-semibold">Headline</span>
                          <button onClick={() => handleCopy(generatedCopy.headline, 'headline')} className="text-xs text-brand-400 hover:text-brand-300 transition-colors flex items-center gap-1 cursor-pointer bg-transparent border-none p-0">
                            {copiedField === 'headline' ? (
                              <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg> Copied!</>
                            ) : (
                              <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg> Copy</>
                            )}
                          </button>
                        </div>
                        <div className="bg-white/[0.02] border border-white/5 rounded-xl p-3 w-full">
                          <p className="text-sm text-white/90 font-medium break-words">{generatedCopy.headline}</p>
                        </div>
                      </div>

                      {/* Description */}
                      <div className="w-full">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] uppercase tracking-wider text-white/50 font-semibold">Link Description</span>
                          <button onClick={() => handleCopy(generatedCopy.description, 'description')} className="text-xs text-brand-400 hover:text-brand-300 transition-colors flex items-center gap-1 cursor-pointer bg-transparent border-none p-0">
                            {copiedField === 'description' ? (
                              <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg> Copied!</>
                            ) : (
                              <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg> Copy</>
                            )}
                          </button>
                        </div>
                        <div className="bg-white/[0.02] border border-white/5 rounded-xl p-3 w-full">
                          <p className="text-sm text-white/70 break-words">{generatedCopy.description}</p>
                        </div>
                      </div>
                      
                    </div>

                    {/* CTA Selector */}
                    <div>
                      <span className="text-xs text-white/40 uppercase tracking-wider">Call to Action Button</span>
                      <div className="flex flex-wrap gap-2 mt-2">
                        {[
                          "Shop Now",
                          "Learn More",
                          "See Collection",
                          "Get Offer",
                          "Sign Up",
                          "Book Now",
                          "Contact Us"
                        ].map((cta) => (
                          <button
                            key={cta}
                            onClick={() => setSelectedCta(cta)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                              selectedCta === cta
                                ? "bg-brand-500/20 border-brand-500/40 text-brand-400"
                                : "bg-white/5 border-white/10 text-white/50 hover:text-white/80"
                            }`}
                          >
                            {cta}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Side Actions & Notes */}
            <div className="md:col-span-4 space-y-4 animate-fade-in-up-delay-2">
              <div className="rounded-xl bg-brand-500/5 border border-brand-500/20 p-5 relative overflow-hidden">
                <div className="absolute -right-4 -top-4 w-16 h-16 bg-brand-500/10 rounded-full blur-xl" />
                <div className="flex items-center gap-2 mb-3 relative z-10">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-brand-400">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                  <h3 className="text-xs font-bold text-brand-400 uppercase tracking-widest">
                    Why this approach
                  </h3>
                </div>
                <p className="text-sm text-white/70 leading-relaxed relative z-10">
                  {generatedCopy.copywriterNote}
                </p>
              </div>

              <div className="rounded-xl bg-surface-raised border border-border-subtle p-5">
                <p className="text-xs text-white/40 mb-4 text-center">Not quite right?</p>
                
                <div className="space-y-3">
                  <button
                    onClick={() => setViewState("media")}
                    className="w-full py-2.5 px-4 rounded-lg bg-white/[0.05] border border-white/10 text-sm font-medium text-white hover:bg-white/[0.08] transition-colors flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                    Upload Different Creative
                  </button>

                  <button
                    onClick={handleGenerate}
                    className="w-full py-2.5 px-4 rounded-lg bg-white/[0.05] border border-white/10 text-sm font-medium text-white hover:bg-white/[0.08] transition-colors flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="1 4 1 10 7 10" />
                      <polyline points="23 20 23 14 17 14" />
                      <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
                    </svg>
                    Generate Another Variation
                  </button>

                  <button
                    onClick={handleStartOver}
                    className="w-full py-2.5 px-4 rounded-lg bg-transparent border border-error-500/20 text-sm font-medium text-error-400 hover:bg-error-500/10 transition-colors flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M19 12H5M12 19l-7-7 7-7" />
                    </svg>
                    Start Over
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="max-w-3xl mx-auto animate-fade-in-up-delay-3 pb-20">
            <button
              onClick={() => setViewState("brief")}
              className="group relative w-full py-5 px-8 rounded-2xl font-bold text-base transition-all duration-300 cursor-pointer"
            >
              <div className="absolute inset-0 rounded-2xl bg-gradient-to-r from-brand-600 to-brand-500 transition-all duration-300 group-hover:from-brand-500 group-hover:to-brand-400" />
              <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 bg-brand-500/20 blur-2xl" />
              <span className="relative flex items-center justify-center gap-3 text-white shadow-sm">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
                Generate Campaign Brief →
              </span>
            </button>

            <button
              onClick={handleGenerate}
              className="w-full mt-3 py-3 px-6 rounded-xl border border-border-subtle text-white/60 font-medium text-sm hover:text-white hover:border-white/20 transition-colors cursor-pointer bg-transparent flex items-center justify-center gap-2"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10" />
                <polyline points="23 20 23 14 17 14" />
                <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
              </svg>
              Generate Another Variation
            </button>

            <p className="text-center text-xs text-white/20 mt-4">
              Your brief will contain everything you need to set up this campaign in Meta Ads Manager
            </p>
          </div>
        </main>
      )}

      {/* -- STATE 4: BRIEF -- */}
      {viewState === "brief" && generatedCopy && (
        <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10 relative flex-1 w-full">
          {/* Brief Header */}
          <div className="text-center mb-10 animate-fade-in-up">
            <div className="w-16 h-16 rounded-full bg-success-500/10 border border-success-500/20 flex items-center justify-center mx-auto mb-6">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-success-400">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-2">
              Your Campaign Brief is Ready
            </h1>
            <p className="text-sm text-white/40">
              Take this into Meta Ads Manager to set up your campaign
            </p>
          </div>

          <div className="space-y-6 animate-fade-in-up-delay-1">
            {/* SECTION: Ad Copy */}
            <div className="rounded-2xl bg-surface-raised border border-border-subtle p-6 relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-brand-500/50 to-brand-400/50" />
              <h3 className="text-sm font-bold text-white/50 uppercase tracking-widest mb-5">Ad Copy</h3>
              <div className="space-y-4">
                {[
                  { label: "Headline", value: generatedCopy.headline, key: "brief-headline" },
                  { label: "Primary Text", value: generatedCopy.primaryText, key: "brief-primary" },
                  { label: "Description", value: generatedCopy.description, key: "brief-desc" },
                  { label: "Call to Action", value: selectedCta || generatedCopy.cta, key: "brief-cta" },
                ].map((item) => (
                  <div key={item.key}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] uppercase tracking-wider text-white/50 font-semibold">{item.label}</span>
                      <button
                        onClick={() => handleCopy(item.value, item.key)}
                        className="text-xs text-brand-400 hover:text-brand-300 transition-colors flex items-center gap-1 cursor-pointer bg-transparent border-none p-0"
                      >
                        {copiedField === item.key ? (
                          <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg> Copied!</>
                        ) : (
                          <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg> Copy</>
                        )}
                      </button>
                    </div>
                    <div className="bg-white/[0.02] border border-white/5 rounded-xl p-3">
                      <p className="text-sm text-white/80 leading-relaxed whitespace-pre-wrap break-words">{item.value}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* SECTION: Targeting */}
            <div className="rounded-2xl bg-surface-raised border border-border-subtle p-6">
              <h3 className="text-sm font-bold text-white/50 uppercase tracking-widest mb-5">Targeting Settings</h3>

              {storeInsights ? (
                <div className="space-y-5">
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">Locations</span>
                    <p className="text-sm text-white/80 mt-1">
                      {aiInsights?.targeting?.locations?.length > 0
                        ? aiInsights.targeting.locations.map((l: any) => l.name).join(" · ")
                        : storeInsights.orders?.top_locations?.length > 0
                          ? storeInsights.orders.top_locations.map((l: any) => `${l.city}`).join(" · ")
                          : "No order data yet — add locations manually based on your target market"}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">Age Range</span>
                      <p className="text-sm text-white/80 mt-1">
                        {aiInsights?.targeting?.age_min
                          ? `${aiInsights.targeting.age_min} — ${aiInsights.targeting.age_max}`
                          : loadingAiInsights ? "Analyzing..." : "25 — 44 (default)"}
                      </p>
                      {aiInsights?.targeting?.age_reasoning && (
                        <p className="text-xs text-white/40 mt-1">{aiInsights.targeting.age_reasoning}</p>
                      )}
                    </div>
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">Gender</span>
                      <p className="text-sm text-white/80 mt-1 capitalize">
                        {aiInsights?.targeting?.gender || (loadingAiInsights ? "Analyzing..." : "All")}
                      </p>
                      {aiInsights?.targeting?.gender_reasoning && (
                        <p className="text-xs text-white/40 mt-1">{aiInsights.targeting.gender_reasoning}</p>
                      )}
                    </div>
                  </div>

                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">Interests to Add in Meta</span>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {aiInsights?.targeting?.interests?.length > 0
                        ? aiInsights.targeting.interests.map((interest: string, i: number) => (
                            <span key={i} className="px-3 py-1 rounded-full text-xs font-medium bg-brand-500/10 border border-brand-500/20 text-brand-400">{interest}</span>
                          ))
                        : loadingAiInsights
                          ? <span className="text-xs text-white/40 italic">Generating interests from your product catalogue...</span>
                          : <span className="text-xs text-white/40 italic">Connect your Shopify store for AI-inferred interests</span>
                      }
                    </div>
                    {aiInsights?.targeting?.interest_reasoning && (
                      <p className="text-xs text-white/40 mt-2">{aiInsights.targeting.interest_reasoning}</p>
                    )}
                  </div>

                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">Behaviours to Add</span>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {(aiInsights?.targeting?.behaviours || ["Engaged Shoppers", "Online Shoppers"]).map((b: string) => (
                        <span key={b} className="px-3 py-1 rounded-full text-xs font-medium bg-success-500/10 border border-success-500/20 text-success-400">{b}</span>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl bg-brand-500/5 border border-brand-500/20 p-4">
                  <p className="text-sm text-brand-400">
                    Connect your Shopify store in Settings for personalised targeting based on your actual customers.
                  </p>
                </div>
              )}
            </div>

            {/* SECTION: Budget */}
            <div className="rounded-2xl bg-surface-raised border border-border-subtle p-6">
              <h3 className="text-sm font-bold text-white/50 uppercase tracking-widest mb-5">Budget</h3>
              {aiInsights?.budget ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">Recommended Daily</span>
                      <p className="text-lg font-bold text-white mt-1">
                        {formatCurrency(aiInsights.budget.recommended_daily, aiInsights.budget.currency)}/day
                      </p>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">Test Duration</span>
                      <p className="text-lg font-bold text-white mt-1">7 days</p>
                    </div>
                  </div>
                  <div className="rounded-xl bg-brand-500/5 border border-brand-500/20 p-4">
                    <p className="text-sm text-brand-400">
                      {aiInsights.budget.reasoning}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl bg-brand-500/5 border border-brand-500/20 p-4">
                  <p className="text-sm text-brand-400">
                    {loadingAiInsights
                      ? "Calculating optimal budget from your store data..."
                      : `Set your own daily budget and duration directly in Meta Ads Manager. We recommend starting with ${formatCurrency(5000, storeInsights?.store?.currency || "USD")}/day for 7 days to test performance.`}
                  </p>
                </div>
              )}
            </div>

            {/* SECTION: Timing */}
            {storeInsights?.orders?.peak_days?.length > 0 && (
              <div className="rounded-2xl bg-surface-raised border border-border-subtle p-6">
                <h3 className="text-sm font-bold text-white/50 uppercase tracking-widest mb-5">Timing</h3>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">Best Days to Run</span>
                  <p className="text-sm text-white/80 mt-1">{storeInsights.orders.peak_days.join(", ")}</p>
                </div>
              </div>
            )}

            {/* SECTION: Actions */}
            <div className="space-y-3 pt-4 pb-10">
              {/* PRIMARY: Download PDF */}
              <button
                onClick={() =>
                  generateBriefPDF({
                    brandName,
                    productName,
                    campaignGoal: goal,
                    copy: {
                      headline: generatedCopy.headline,
                      primaryText: generatedCopy.primaryText,
                      description: generatedCopy.description,
                      cta: selectedCta || generatedCopy.cta,
                      copywriterNote: generatedCopy.copywriterNote,
                    },
                    targeting: aiInsights?.targeting ?? {},
                    budget: aiInsights?.budget ?? {},
                    timing: aiInsights?.timing ?? {},
                    warnings: aiInsights?.warnings ?? [],
                    generatedAt: new Date().toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                    }),
                  })
                }
                className="w-full py-4 px-6 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 hover:from-brand-500 hover:to-brand-400 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all duration-300 cursor-pointer"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download PDF Brief
              </button>

              {/* SECONDARY: Copy to clipboard */}
              <button
                onClick={() => {
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
                    aiInsights?.targeting?.locations?.length > 0
                      ? `Locations: ${aiInsights.targeting.locations.map((l: any) => l.name).join(", ")}`
                      : "Locations: Set manually",
                    `Age: ${aiInsights?.targeting?.age_min || 25} — ${aiInsights?.targeting?.age_max || 44}`,
                    `Gender: ${aiInsights?.targeting?.gender || "All"}`,
                    `Interests: ${aiInsights?.targeting?.interests?.join(", ") || "Set manually"}`,
                    `Behaviours: ${(aiInsights?.targeting?.behaviours || ["Engaged Shoppers", "Online Shoppers"]).join(", ")}`,
                    "",
                    "── BUDGET ──",
                    aiInsights?.budget
                      ? `Recommended: ${formatCurrency(aiInsights.budget.recommended_daily, aiInsights.budget.currency)}/day for 7 days`
                      : `Recommended starting budget: ${formatCurrency(5000, storeInsights?.store?.currency || "USD")}/day for 7 days`,
                    aiInsights?.budget?.reasoning || "Set final budget in Meta Ads Manager",
                    "",
                    "── TIMING ──",
                    storeInsights?.orders?.peak_days?.length > 0
                      ? `Best days: ${storeInsights.orders.peak_days.join(", ")}`
                      : "No timing data yet",
                    "",
                    "Generated by omni-target"
                  ].join("\n");
                  navigator.clipboard.writeText(briefText);
                  setCopiedField("full-brief");
                  setTimeout(() => setCopiedField(null), 2000);
                }}
                className="w-full py-3 px-6 rounded-xl border border-border-subtle text-white/60 font-medium text-sm hover:text-white hover:border-white/20 transition-colors cursor-pointer bg-transparent flex items-center justify-center gap-2"
              >
                {copiedField === "full-brief" ? (
                  <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg> Copied!</>
                ) : (
                  <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg> Copy Brief to Clipboard</>
                )}
              </button>

              <button
                onClick={() => {
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
                  setSelectedCta("");
                  setViewState("media");
                }}
                className="w-full py-3 px-6 rounded-xl border border-border-subtle/50 text-white/30 font-medium text-sm hover:text-white/60 hover:border-white/10 transition-colors cursor-pointer bg-transparent"
              >
                Create New Brief
              </button>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}

export default function CampaignsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-brand-500/20 border-t-brand-500 animate-spin" />
      </div>
    }>
      <CampaignsContent />
    </Suspense>
  );
}
