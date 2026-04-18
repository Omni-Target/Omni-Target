"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { advanceOnboardingStep } from "../actions";

// TODO: Replace with Meta OAuth

function MetaIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 36 36" fill="currentColor">
      <path d="M6.58 5.69C8.2 3.69 10.23 2.5 12.5 2.5c3.13 0 5.1 1.84 7.5 5.7 1.67-2.7 3.56-5.7 7.5-5.7 2.27 0 4.3 1.19 5.92 3.19C35.25 8.24 36 11.6 36 15c0 5.52-3.14 10.31-7.2 13.6C25.02 31.9 20.4 33.5 18 33.5s-7.02-1.6-10.8-4.9C3.14 25.31 0 20.52 0 15c0-3.4.75-6.76 2.58-9.31h4zM12.5 6.5c-1.07 0-2.22.75-3.28 2.06C7.8 10.44 7 13.01 7 15c0 3.99 2.3 7.83 5.4 10.4C15.1 27.63 17.62 29.5 18 29.5s2.9-1.87 5.6-4.1C26.7 22.83 29 18.99 29 15c0-1.99-.8-4.56-2.22-6.44C25.72 7.25 24.57 6.5 23.5 6.5c-1.85 0-3.15 1.85-5.08 5.4l-0.42.76-.42-.76C15.65 8.35 14.35 6.5 12.5 6.5z" />
    </svg>
  );
}

export default function ConnectMetaPage() {
  const router = useRouter();
  const [isConnecting, setIsConnecting] = useState(false);

  const handleConnect = () => {
    setIsConnecting(true);
    window.location.href = "/api/auth/meta/connect";
  };

  return (
    <div className="text-center">
      {/* Step indicator */}
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-500/10 border border-brand-500/20 mb-6 animate-fade-in-up">
        <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse" />
        <span className="text-xs font-medium text-brand-400">
          Step 2 of 3
        </span>
      </div>

      {/* Heading */}
      <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-3 animate-fade-in-up-delay-1">
        Connect Your Meta
        <br />
        Ad Account
      </h1>
      <p className="text-sm text-white/50 leading-relaxed mb-8 max-w-xs mx-auto animate-fade-in-up-delay-2">
        We&apos;ll audit your pixel configuration and ensure you&apos;re
        optimizing for purchases — not just clicks.
      </p>

      {/* CTA Button */}
      <button
        id="connect-meta-btn"
        onClick={handleConnect}
        disabled={isConnecting}
        className="group relative w-full py-4 px-6 rounded-xl font-semibold text-sm transition-all duration-300 animate-fade-in-up-delay-3 cursor-pointer disabled:cursor-not-allowed"
      >
        {/* Gradient background */}
        <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 transition-all duration-300 group-hover:from-brand-500 group-hover:to-brand-400 group-disabled:opacity-70" />

        {/* Glow effect */}
        <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-brand-500/20 blur-xl" />

        {/* Content */}
        <span className="relative flex items-center justify-center gap-3 text-white">
          {isConnecting ? (
            <>
              <svg
                className="animate-spin h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span>Connecting to Meta...</span>
            </>
          ) : (
            <>
              <MetaIcon />
              <span>Connect Meta Ad Account</span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="transition-transform duration-200 group-hover:translate-x-0.5"
              >
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </>
          )}
        </span>
      </button>

      {/* Skip option */}
      <button 
        onClick={async () => {
          await advanceOnboardingStep("complete");
          router.push("/dashboard");
        }}
        className="text-xs text-white/30 hover:text-white/50 transition-colors mt-4 underline underline-offset-2"
      >
        Skip for now — I'll connect Meta later
      </button>

      <p className="text-xs text-white/40 mt-8 max-w-[280px] mx-auto animate-fade-in-up-delay-3 lg:max-w-xs">
        We only request permissions needed to create and manage your ads. We never post on your behalf.
      </p>

      {/* Trust indicators */}
      <div className="mt-8 flex items-center justify-center gap-6 text-white/25 animate-fade-in-up-delay-4">
        <div className="flex items-center gap-2">
          <svg
            width="14"
            height="14"
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
          <span className="text-xs">Read-only access</span>
        </div>
        <div className="flex items-center gap-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span className="text-xs">2,400+ merchants</span>
        </div>
      </div>
    </div>
  );
}
