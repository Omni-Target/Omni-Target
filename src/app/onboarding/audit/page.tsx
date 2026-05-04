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
    text: "Generating Intelligence Report...",
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
  pixelFound: boolean;
  pixelId?: string;
  pixelHealth: string;
  score: number;
  issues: string[];
  recommendations?: string[];
  events?: { name: string; count: number }[];
  message?: string;
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

    // After 3s of animation, call real API
    const apiTimer = setTimeout(async () => {
      clearInterval(stepInterval);
      setCurrentStep(STEPS.length); // mark all steps done
      try {
        const res = await fetch("/api/pixel/audit");
        if (!res.ok) throw new Error("Audit API failed");
        const data: AuditResult = await res.json();
        setAuditResult(data);
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
    if (score >= 30) return "text-amber-400";
    return "text-error-400";
  };

  const healthLabel = (health: string) => {
    switch (health) {
      case "healthy":
        return { text: "Healthy", cls: "bg-success-500/10 border-success-500/20 text-success-400" };
      case "broken":
        return { text: "Issues Detected", cls: "bg-amber-500/10 border-amber-500/20 text-amber-400" };
      default:
        return { text: "No Pixel Found", cls: "bg-error-500/10 border-error-500/20 text-error-400" };
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
            Auditing Your Account
          </h2>
          <p className="text-sm text-white/40 mb-8 animate-fade-in-up-delay-1">
            This usually takes a few seconds
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
        <div className="animate-fade-in-up">
          {/* Score Circle */}
          <div className="relative w-24 h-24 mx-auto mb-6">
            <div className={`w-full h-full rounded-full border-4 ${
              auditResult.score >= 70
                ? "border-success-500/40"
                : auditResult.score >= 30
                  ? "border-amber-500/40"
                  : "border-error-500/40"
            } flex items-center justify-center`}>
              <span className={`text-3xl font-bold ${scoreColor(auditResult.score)}`}>
                {auditResult.score}
              </span>
            </div>
          </div>

          <h2 className="text-xl font-semibold text-white mb-2">
            Audit Complete
          </h2>

          {/* Health Badge */}
          {(() => {
            const h = healthLabel(auditResult.pixelHealth);
            return (
              <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium border ${h.cls} mb-6`}>
                {h.text}
              </span>
            );
          })()}

          {/* Issues */}
          {auditResult.issues.length > 0 && (
            <div className="text-left space-y-2 mb-6">
              <p className="text-xs font-medium text-white/50 uppercase tracking-wider mb-2">Issues Found</p>
              {auditResult.issues.map((issue, i) => (
                <div key={i} className="flex items-start gap-2 px-4 py-3 rounded-lg bg-error-500/10 border border-error-500/20">
                  <svg className="shrink-0 mt-0.5 text-error-400" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span className="text-sm text-error-400">{issue}</span>
                </div>
              ))}
            </div>
          )}

          {/* Recommendations */}
          {auditResult.recommendations && auditResult.recommendations.length > 0 && (
            <div className="text-left space-y-2 mb-6">
              <p className="text-xs font-medium text-white/50 uppercase tracking-wider mb-2">Recommendations</p>
              {auditResult.recommendations.map((rec, i) => (
                <div key={i} className="flex items-start gap-2 px-4 py-3 rounded-lg bg-brand-500/10 border border-brand-500/20">
                  <svg className="shrink-0 mt-0.5 text-brand-400" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                  <span className="text-sm text-brand-400">{rec}</span>
                </div>
              ))}
            </div>
          )}

          {/* Event Tracking Summary */}
          {auditResult.events && auditResult.events.length > 0 && (
            <div className="text-left mb-6">
              <p className="text-xs font-medium text-white/50 uppercase tracking-wider mb-2">Tracked Events</p>
              <div className="grid grid-cols-2 gap-2">
                {auditResult.events.map((ev, i) => (
                  <div key={i} className="px-3 py-2 rounded-lg bg-white/[0.03] border border-white/5">
                    <p className="text-xs text-white/40">{ev.name}</p>
                    <p className="text-sm font-semibold text-white">{ev.count?.toLocaleString() || "0"}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Continue Button */}
          <button
            onClick={handleContinue}
            disabled={completing}
            className="group relative w-full py-4 px-6 rounded-xl font-semibold text-sm transition-all duration-300 cursor-pointer mt-4 disabled:opacity-70 disabled:cursor-not-allowed"
          >
            <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 transition-all duration-300 group-hover:from-brand-500 group-hover:to-brand-400" />
            <span className="relative flex items-center justify-center gap-2 text-white">
              {completing ? "Taking you to your dashboard..." : fromDashboard ? "Return to Dashboard" : "Continue to Dashboard"}
              {!completing && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-200 group-hover:translate-x-1">
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
