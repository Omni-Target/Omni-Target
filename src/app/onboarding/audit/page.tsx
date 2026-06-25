"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { advanceOnboardingStep } from "../actions";

const STEPS = [
  {
    text: "Syncing Store Data...",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
  },
  {
    text: "Analyzing Performance Metrics...",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="M21 21l-4.35-4.35" />
      </svg>
    ),
  },
  {
    text: "Generating Readiness Report...",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    ),
  },
];

interface AuditResult {
  score: number;
  status: string;
  issues: string[];
  recommendations?: string[];
  positives?: string[];
  breakdown?: {
    products: number;
    orders: number;
    retention: number;
    availability: number;
  };
}

export default function AuditPage() {
  const router = useRouter();
  const { user } = useUser();
  const [currentStep, setCurrentStep] = useState(0);
  const [auditResult, setAuditResult] = useState<AuditResult | null>(null);
  const [auditError, setAuditError] = useState("");
  const [scanning, setScanning] = useState(true);
  const [completing, setCompleting] = useState(false);
  const [fromDashboard, setFromDashboard] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const searchParams = new URLSearchParams(window.location.search);
      setFromDashboard(searchParams.get("from") === "dashboard");
    }

    const stepInterval = setInterval(() => {
      setCurrentStep((prev) => {
        if (prev < STEPS.length - 1) return prev + 1;
        return prev;
      });
    }, 1000);

    // After 3s of animation, trigger store data fetch then audit
    const apiTimer = setTimeout(async () => {
      clearInterval(stepInterval);
      setCurrentStep(STEPS.length); // mark all steps done
      try {
        // Step 1: Trigger store data fetch — this populates the
        // store_snapshot in the DB that the audit endpoint needs.
        // Without this, the audit always returns "syncing".
        await fetch("/api/store/data");

        // Step 2: Now run the audit (snapshot should be populated)
        // Retry up to 3 times if we still get "syncing"
        let auditData: AuditResult | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          const res = await fetch("/api/pixel/audit");
          if (!res.ok) throw new Error("Audit API failed");
          const data: AuditResult = await res.json();
          
          if (data.status !== "syncing") {
            auditData = data;
            break;
          }
          
          // Wait 2s before retrying
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            // Last attempt — use whatever we got
            auditData = data;
          }
        }

        setAuditResult(auditData);
      } catch (err) {
        console.error("Audit error:", err);
        setAuditError("Failed to complete audit. Please try again.");
      } finally {
        setScanning(false);
      }
    }, 3000);

    return () => {
      clearInterval(stepInterval);
      clearTimeout(apiTimer);
    };
  }, []);

  const handleContinue = async () => {
    setCompleting(true);
    if (!fromDashboard) {
      try {
        await fetch("/api/user/update-metadata", {
          method: "POST", 
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            onboardingStep: "complete"
          }),
        });
      } catch (err) {
        console.error("Failed to update onboarding step:", err);
      }
    }
    // Full page navigation so the middleware re-checks the fresh metadata
    window.location.href = "/dashboard";
  };

  const scoreColor = (score: number) => {
    if (score >= 70) return "text-success-400";
    if (score >= 40) return "text-amber-400";
    return "text-error-400";
  };

  const scoreBorderColor = (score: number) => {
    if (score >= 70) return "border-success-500/40";
    if (score >= 40) return "border-amber-500/40";
    return "border-error-500/40";
  };

  const statusLabel = (status: string) => {
    switch (status) {
      case "healthy":
        return { text: "Store Ready", cls: "bg-success-500/10 border-success-500/20 text-success-400" };
      case "moderate":
        return { text: "Needs Some Work", cls: "bg-amber-500/10 border-amber-500/20 text-amber-400" };
      case "syncing":
        return { text: "Sync in Progress", cls: "bg-brand-500/10 border-brand-500/20 text-brand-400 animate-pulse" };
      case "not_connected":
        return { text: "Disconnected", cls: "bg-error-500/10 border-error-500/20 text-error-400" };
      default:
        return { text: "Needs Attention", cls: "bg-error-500/10 border-error-500/20 text-error-400" };
    }
  };

  return (
    <div className="text-center">
      {fromDashboard && (
        <div className="mb-6 text-left animate-fade-in-up">
          <Link 
            href="/dashboard"
            className="flex items-center gap-2 text-sm text-white/40 hover:text-white/70 transition-colors w-fit no-underline"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
            Back to Dashboard
          </Link>
        </div>
      )}

      {/* Step indicator */}
      {!fromDashboard && (
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-500/10 border border-brand-500/20 mb-6 animate-fade-in-up">
          <span className="text-xs font-medium text-brand-400">
            Step 2 of 2
          </span>
        </div>
      )}

      {/* Scanning Animation (shown while scanning) */}
      {scanning && (
        <>
          {/* Scanner Animation */}
          <div className="relative w-20 h-20 mx-auto mb-8">
            {/* Outer ring */}
            <div className="absolute inset-0 rounded-full border-2 border-brand-500/20" />
            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-brand-500 animate-spin" />

            {/* Mid ring */}
            <div className="absolute inset-2 rounded-full border border-brand-400/15" />
            <div
              className="absolute inset-2 rounded-full border border-transparent border-t-brand-400 animate-spin"
              style={{ animationDuration: "1.5s", animationDirection: "reverse" }}
            />

            {/* Inner core */}
            <div className="absolute inset-4 rounded-full bg-gradient-to-br from-brand-500/20 to-brand-600/20 flex items-center justify-center">
              <div className="w-4 h-4 rounded-full bg-brand-500 animate-pulse shadow-lg shadow-brand-500/50" />
            </div>

            {/* Pulse rings */}
            <div className="absolute inset-0 rounded-full border border-brand-500/10 animate-pulse-ring" />
          </div>

          {/* Title */}
          <h2 className="text-xl font-semibold text-white mb-2 animate-fade-in-up">
            Store Readiness Audit
          </h2>
          <p className="text-sm text-white/40 mb-8 animate-fade-in-up-delay-1">
            We&apos;re analysing your Shopify store to see how ready it is for high-converting Meta ads.
          </p>

          {/* Progress Steps */}
          <div className="space-y-3 mb-8">
            {STEPS.map((step, index) => (
              <div
                key={index}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-500 ${
                  index < currentStep
                    ? "bg-success-500/10 border border-success-500/20"
                    : index === currentStep
                    ? "bg-brand-500/10 border border-brand-500/20"
                    : "bg-white/[0.02] border border-transparent"
                }`}
              >
                {/* Status indicator */}
                <div className="flex-shrink-0">
                  {index < currentStep ? (
                    <div className="w-5 h-5 rounded-full bg-success-500/20 flex items-center justify-center">
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="text-success-400"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                  ) : index === currentStep ? (
                    <div className="w-5 h-5 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
                  ) : (
                    <div className="w-5 h-5 rounded-full border border-white/10" />
                  )}
                </div>

                {/* Step icon & text */}
                <span
                  className={`text-sm transition-colors duration-300 ${
                    index < currentStep
                      ? "text-success-400"
                      : index === currentStep
                      ? "text-white"
                      : "text-white/30"
                  }`}
                >
                  {step.text}
                </span>
              </div>
            ))}
          </div>

          {/* Progress Bar */}
          <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-brand-600 via-brand-500 to-brand-400 rounded-full animate-progress-fill" />
          </div>
        </>
      )}

      {/* Results (shown after scanning) */}
      {!scanning && auditResult && (
        <div className="animate-fade-in-up w-full max-w-2xl mx-auto">
          
          {/* Main Glass Card */}
          <div className="relative overflow-hidden rounded-2xl bg-[#111118]/80 backdrop-blur-xl border border-white/10 p-8 shadow-2xl mb-8">
            
            {/* Subtle Gradient Glow Background */}
            <div className="absolute -top-40 -left-40 w-80 h-80 bg-brand-500/10 rounded-full blur-[100px] pointer-events-none" />
            <div className="absolute -bottom-40 -right-40 w-80 h-80 bg-brand-600/10 rounded-full blur-[100px] pointer-events-none" />
            
            <div className="relative z-10">
              {auditResult.status === "syncing" ? (
                <div className="text-center py-10">
                  <div className="relative w-32 h-32 mx-auto mb-8">
                    <div className="absolute inset-0 rounded-full border-4 border-brand-500/10" />
                    <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-brand-500 animate-spin" style={{ animationDuration: "1.5s" }} />
                    <div className="absolute inset-4 rounded-full border-4 border-transparent border-r-brand-400 animate-spin" style={{ animationDuration: "2s", animationDirection: "reverse" }} />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-400 animate-pulse">
                        <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                        <path d="M21 3v5h-5" />
                      </svg>
                    </div>
                  </div>
                  <h2 className="text-2xl font-bold text-white tracking-tight mb-3">Background Sync in Progress</h2>
                  <p className="text-sm text-white/60 mb-8 max-w-md mx-auto leading-relaxed">
                    We're securely pulling your product catalog and recent order history to generate your readiness score. This usually takes just a few moments.
                  </p>
                  {/* Status Badge */}
                  <span className="inline-flex items-center px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest border bg-brand-500/10 border-brand-500/20 text-brand-400 shadow-lg backdrop-blur-md animate-pulse">
                    Data Syncing
                  </span>
                </div>
              ) : (
                <>
                  {/* Score SVG Gauge */}
                  <div className="relative w-40 h-40 mx-auto mb-8 drop-shadow-2xl">
                    <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                      <circle cx="50" cy="50" r="42" className="stroke-white/5" strokeWidth="8" fill="none" />
                      <circle 
                        cx="50" cy="50" r="42" 
                        className={`${auditResult.score >= 70 ? "stroke-success-500" : auditResult.score >= 40 ? "stroke-amber-500" : "stroke-error-500"} transition-all duration-1500 ease-out`} 
                        strokeWidth="8" 
                        fill="none" 
                        strokeDasharray={2 * Math.PI * 42} 
                        strokeDashoffset={(2 * Math.PI * 42) - ((auditResult.score / 100) * (2 * Math.PI * 42))} 
                        strokeLinecap="round" 
                        style={{ filter: "drop-shadow(0 0 8px currentColor)" }}
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className={`text-5xl font-extrabold tracking-tight ${scoreColor(auditResult.score)} drop-shadow-md`}>
                        {auditResult.score}
                      </span>
                      <span className="text-[10px] text-white/40 font-bold tracking-[0.2em] uppercase mt-1">Score</span>
                    </div>
                  </div>

                  <h2 className="text-2xl font-bold text-white tracking-tight mb-3">
                    Store Readiness Audit
                  </h2>

                  {/* Status Badge */}
                  <div className="mb-10">
                    {(() => {
                      const s = statusLabel(auditResult.status);
                      return (
                        <span className={`inline-flex items-center px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest border ${s.cls} shadow-lg backdrop-blur-md`}>
                          {s.text}
                        </span>
                      );
                    })()}
                  </div>

                  {/* Breakdown Grid */}
                  {auditResult.breakdown && (
                    <div className="text-left mb-10">
                      <p className="text-[11px] font-bold text-white/40 uppercase tracking-[0.15em] mb-4 flex items-center gap-2">
                        <span className="w-4 h-[1px] bg-white/20"></span>
                        Score Breakdown
                        <span className="flex-1 h-[1px] bg-white/5"></span>
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {[
                          { label: "Products", score: auditResult.breakdown.products, max: 25, icon: "M16 14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8z M16 14v4a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2h-4 M6 6h.01" },
                          { label: "Orders", score: auditResult.breakdown.orders, max: 25, icon: "M9 5H7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2V7a2 2 0 0 0 -2 -2h-2 M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2 M9 5a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2 M12 12h.01 M12 16h.01 M8 12h.01 M8 16h.01 M16 12h.01 M16 16h.01" },
                          { label: "Retention", score: auditResult.breakdown.retention, max: 25, icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75" },
                          { label: "Availability", score: auditResult.breakdown.availability, max: 25, icon: "M12 2v20 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" },
                        ].map((item) => {
                          const percentage = Math.round((item.score / item.max) * 100);
                          const isGood = item.score >= item.max * 0.7;
                          const isOk = item.score >= item.max * 0.4;
                          
                          return (
                            <div key={item.label} className="group px-4 py-3.5 rounded-xl bg-white/[0.02] hover:bg-white/[0.04] border border-white/5 hover:border-white/10 transition-colors">
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/30 group-hover:text-white/50 transition-colors">
                                    <path d={item.icon} />
                                  </svg>
                                  <span className="text-xs font-semibold text-white/70">{item.label}</span>
                                </div>
                                <span className={`text-xs font-bold ${isGood ? "text-success-400" : isOk ? "text-amber-400" : "text-error-400"}`}>
                                  {percentage}%
                                </span>
                              </div>
                              <div className="h-1.5 bg-black/40 rounded-full overflow-hidden shadow-inner">
                                <div
                                  className={`h-full rounded-full transition-all duration-1000 ease-out shadow-[0_0_10px_currentColor] ${isGood ? "bg-success-400" : isOk ? "bg-amber-400" : "bg-error-400"}`}
                                  style={{ width: `${percentage}%` }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Lists Section */}
                  <div className="space-y-6">
                    {/* Positives */}
                    {auditResult.positives && auditResult.positives.length > 0 && (
                      <div className="text-left">
                        <p className="text-[11px] font-bold text-success-400/70 uppercase tracking-[0.15em] mb-3 flex items-center gap-2">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                          Start Here
                        </p>
                        <div className="space-y-2">
                          {auditResult.positives.map((item, i) => (
                            <div key={i} className="flex items-start gap-3 px-4 py-3 rounded-xl bg-success-500/5 border border-success-500/10">
                              <div className="w-1.5 h-1.5 rounded-full bg-success-400 mt-1.5 shadow-[0_0_8px_rgba(52,211,153,0.8)] shrink-0" />
                              <span className="text-sm text-success-100/80 leading-relaxed">{item}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Issues */}
                    {auditResult.issues.length > 0 && (
                      <div className="text-left">
                        <p className="text-[11px] font-bold text-amber-400/70 uppercase tracking-[0.15em] mb-3 flex items-center gap-2">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
                          What to Know
                        </p>
                        <div className="space-y-2">
                          {auditResult.issues.map((issue, i) => (
                            <div key={i} className="flex items-start gap-3 px-4 py-3 rounded-xl bg-amber-500/5 border border-amber-500/10">
                              <div className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 shadow-[0_0_8px_rgba(251,191,36,0.8)] shrink-0" />
                              <span className="text-sm text-amber-100/80 leading-relaxed">{issue}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Recommendations */}
                    {auditResult.recommendations && auditResult.recommendations.length > 0 && (
                      <div className="text-left">
                        <p className="text-[11px] font-bold text-brand-400/70 uppercase tracking-[0.15em] mb-3 flex items-center gap-2">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
                          Your Ad Strategy
                        </p>
                        <div className="space-y-2">
                          {auditResult.recommendations.map((rec, i) => (
                            <div key={i} className="flex items-start gap-3 px-4 py-3 rounded-xl bg-brand-500/10 border border-brand-500/20 backdrop-blur-sm">
                              <div className="w-1.5 h-1.5 rounded-full bg-brand-400 mt-1.5 shadow-[0_0_8px_rgba(129,140,248,0.8)] shrink-0 animate-pulse" />
                              <span className="text-sm font-medium text-brand-50 leading-relaxed">{rec}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Continue Button */}
          <button
            onClick={handleContinue}
            disabled={completing}
            className="group relative w-full sm:w-auto min-w-[280px] py-4 px-8 rounded-xl font-bold text-sm transition-all duration-300 cursor-pointer disabled:opacity-70 disabled:cursor-not-allowed mx-auto block overflow-hidden"
          >
            {/* Animated Button Background Sheen */}
            <div className="absolute inset-0 bg-gradient-to-r from-brand-600 via-brand-500 to-brand-600 bg-[length:200%_auto] animate-shimmer group-hover:scale-105 transition-transform duration-500" />
            <div className="absolute inset-0 opacity-0 group-hover:opacity-100 bg-white/20 transition-opacity duration-300" />
            
            <span className="relative flex items-center justify-center gap-2 text-white">
              {completing ? "Taking you to your dashboard..." : fromDashboard ? "Return to Dashboard" : "Continue to Dashboard"}
              {!completing && (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-300 group-hover:translate-x-1.5">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              )}
            </span>
          </button>
        </div>
      )}

      {/* Error State */}
      {!scanning && auditError && (
        <div className="animate-fade-in-up">
          <div className="w-16 h-16 rounded-full bg-error-500/10 flex items-center justify-center mx-auto mb-4">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-error-400">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-white mb-2">Audit Failed</h2>
          <p className="text-sm text-error-400 mb-6">{auditError}</p>
          <button
            onClick={handleContinue}
            disabled={completing}
            className="px-6 py-3 rounded-xl bg-brand-500 text-white text-sm font-medium transition-colors hover:bg-brand-400 cursor-pointer disabled:opacity-70 disabled:cursor-not-allowed"
          >
            {completing ? "Taking you to your dashboard..." : fromDashboard ? "Return to Dashboard →" : "Continue to Dashboard →"}
          </button>
        </div>
      )}
    </div>
  );
}
