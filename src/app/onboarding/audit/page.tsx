"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { advanceOnboardingStep } from "../actions";

const STEPS = [
  {
    text: "Authenticating Meta Business Manager...",
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
    text: "Scanning Ad Accounts...",
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
    text: "Checking for Active Purchase Pixels...",
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

export default function AuditPage() {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    const stepInterval = setInterval(() => {
      setCurrentStep((prev) => {
        if (prev < STEPS.length - 1) return prev + 1;
        return prev;
      });
    }, 1000);

    const redirectTimer = setTimeout(async () => {
      await advanceOnboardingStep("complete");
      router.push("/dashboard");
    }, 3000);

    return () => {
      clearInterval(stepInterval);
      clearTimeout(redirectTimer);
    };
  }, [router]);

  return (
    <div className="text-center">
      {/* Step indicator */}
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-500/10 border border-brand-500/20 mb-6 animate-fade-in-up">
        <span className="text-xs font-medium text-brand-400">
          Step 3 of 3
        </span>
      </div>

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
    </div>
  );
}
