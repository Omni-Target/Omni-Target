"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { SignOutButton } from "@clerk/nextjs";

type CampaignState = "input" | "generating" | "review";

interface GeneratedCopy {
  headline: string;
  primaryText: string;
  description: string;
  cta: string;
  copywriterNote: string;
}

export default function CampaignsPage() {
  const router = useRouter();
  
  // Overall State
  const [viewState, setViewState] = useState<CampaignState>("input");
  const [errorMsg, setErrorMsg] = useState("");

  // Form State
  const [brandName, setBrandName] = useState(""); // TODO: Auto-fill from StoreContext
  const [productName, setProductName] = useState("");
  const [description, setDescription] = useState("");
  const [audience, setAudience] = useState("");
  const [goal, setGoal] = useState("Drive Website Sales");
  const [tone, setTone] = useState("Let AI decide (recommended)");

  // API State
  const [generatedCopy, setGeneratedCopy] = useState<GeneratedCopy | null>(null);

  // Review State Action
  const [isLaunching, setIsLaunching] = useState(false);
  const [showToast, setShowToast] = useState(false);

  const handleGenerate = async () => {
    // Basic frontend validation for required fields
    if (!brandName || !productName || !description) {
      setErrorMsg("Please fill in Brand Name, Product Name, and Product Description.");
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
          targetAudience: audience,
          campaignGoal: goal,
          tonePreference: tone,
        }),
      });

      if (!res.ok) {
        throw new Error("API returned an error");
      }

      const data: GeneratedCopy = await res.json();
      setGeneratedCopy(data);
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
    setAudience("");
    setGoal("Drive Website Sales");
    setTone("Let AI decide (recommended)");
    setGeneratedCopy(null);
    setErrorMsg("");
    setViewState("input");
  };

  const handleLaunch = () => {
    setIsLaunching(true);
    setShowToast(true);
    setTimeout(() => {
      router.push("/dashboard");
    }, 2000);
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
            <Link href="/settings" className="text-sm font-medium text-white/60 hover:text-white/90 transition-colors">Settings</Link>
          </div>
          <div className="flex items-center gap-6">
            <SignOutButton>
              <button className="text-xs font-medium text-white/40 hover:text-white/80 transition-colors cursor-pointer bg-transparent border-none p-0">
                Sign Out
              </button>
            </SignOutButton>
            {viewState === "review" ? (
              <button 
                onClick={() => setViewState("input")} 
                className="text-white/40 hover:text-white/60 transition-colors flex items-center gap-1.5 cursor-pointer bg-transparent border-none p-0"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
                Edit Campaign
              </button>
            ) : (
              <div className="flex items-center gap-2 text-xs text-white/40">
                <div className="w-2 h-2 rounded-full bg-success-400 animate-pulse" />
                Meta Connected
              </div>
            )}
          </div>
        </div>
      </nav>

      {/* Background orbs */}
      <div className="fixed top-0 left-1/4 w-[500px] h-[500px] bg-brand-600/5 rounded-full blur-[120px] pointer-events-none" />
      <div className={`fixed bottom-0 right-1/4 w-[400px] h-[400px] rounded-full blur-[100px] pointer-events-none transition-colors duration-1000 ${viewState === 'review' ? 'bg-success-500/5' : 'bg-brand-400/5'}`} />

      {/* -- STATE 1: INPUT FORM -- */}
      {viewState === "input" && (
        <main className="max-w-2xl mx-auto px-4 sm:px-6 py-10 relative flex-1">
          <div className="mb-8 animate-fade-in-up">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-500/10 border border-brand-500/20 mb-4">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-400">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
              <span className="text-xs font-medium text-brand-400">Campaign Engine</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-2">
              Create a New Campaign
            </h1>
            <p className="text-sm text-white/40">
              Provide context about your product. Our AI will craft personalized, high-converting ad copy.
            </p>
          </div>

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

            {/* Target Audience */}
            <div>
              <label htmlFor="audience" className="block text-xs font-medium text-white/50 uppercase tracking-wider mb-2">
                Target Audience
              </label>
              <input
                id="audience"
                type="text"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                placeholder="e.g. Professional women aged 28–40 in Lagos"
                className="w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-border-subtle text-sm text-white placeholder:text-white/20 outline-none transition-all duration-200 focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/20"
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
                    <option value="Grow Instagram Following" className="bg-[#09090f] text-white">Grow Instagram Following</option>
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
              Generate AI Ad Creatives
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-200 group-hover:translate-x-0.5">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
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
            {/* Main Creative Card */}
            <div className="md:col-span-8 animate-fade-in-up-delay-1">
              <div className="rounded-2xl bg-surface-raised border border-border-subtle p-6 sm:p-8 shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-brand-500/50 to-brand-400/50" />
                
                <h2 className="text-3xl font-bold text-white mb-4 leading-tight">
                  {generatedCopy.headline}
                </h2>
                
                <div className="mb-6 bg-white/[0.02] border border-white/5 rounded-xl p-4">
                  <p className="text-base text-white/80 leading-relaxed whitespace-pre-wrap">
                    {generatedCopy.primaryText}
                  </p>
                </div>
                
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mt-8 pt-6 border-t border-border-subtle">
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-white/30 font-semibold block mb-1">
                      Link Description (Facebook Only)
                    </span>
                    <p className="text-sm text-white/50">{generatedCopy.description}</p>
                  </div>
                  <div>
                    <span className="inline-flex px-4 py-2 rounded-lg bg-white/10 text-xs font-bold text-white/90 uppercase tracking-wide border border-white/10 shadow-sm whitespace-nowrap">
                      {generatedCopy.cta}
                    </span>
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
              onClick={handleLaunch}
              disabled={isLaunching}
              className="group relative w-full py-5 px-8 rounded-2xl font-bold text-base transition-all duration-300 cursor-pointer disabled:cursor-not-allowed"
            >
              <div className="absolute inset-0 rounded-2xl bg-gradient-to-r from-success-600 via-success-500 to-success-400 transition-all duration-300 group-hover:from-success-500 group-hover:via-success-400 group-hover:to-success-300 group-disabled:opacity-70" />
              <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 bg-success-500/20 blur-2xl" />
              <span className="relative flex items-center justify-center gap-3 text-white shadow-sm">
                {isLaunching ? (
                  <>
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Deploying to Meta Ads...
                  </>
                ) : (
                  <>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 2L11 13" />
                      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
                    </svg>
                    Launch Campaign to Meta
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-200 group-hover:translate-x-0.5">
                      <path d="M5 12h14M12 5l7 7-7 7" />
                    </svg>
                  </>
                )}
              </span>
            </button>
            <p className="text-center text-xs text-white/20 mt-4">
              Your campaign connects directly to your authorized Meta Ads Manager
            </p>
          </div>
        </main>
      )}

      {/* Toast */}
      {showToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-fade-in-up">
          <div className="flex items-center gap-3 px-5 py-3 rounded-xl bg-surface-raised border border-success-500/30 shadow-2xl shadow-black/50">
            <div className="w-6 h-6 rounded-full bg-success-500/20 flex items-center justify-center">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-success-400">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <span className="text-sm text-white font-medium">Deploying campaign to Meta Ads...</span>
          </div>
        </div>
      )}
    </div>
  );
}
