"use client";

import React, { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { advanceOnboardingStep } from "../actions";

// TODO: Replace with Shopify OAuth

function isValidStoreUrl(input: string): boolean {
  try {
    // Accept any of these formats:
    // k-kasa.com
    // www.k-kasa.com
    // https://www.k-kasa.com
    // kkasa.myshopify.com
    // https://kkasa.myshopify.com
    
    const url = input.startsWith('http') 
      ? input 
      : `https://${input}`;
      
    const parsed = new URL(url);
    
    // Must have a valid hostname with at least 
    // one dot (eliminates random strings)
    return parsed.hostname.includes('.');
    
  } catch {
    return false;
  }
}


function ConnectShopifyContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [storeUrl, setStoreUrl] = useState("");
  const [isResolving, setIsResolving] = useState(false);
  const [resolvedDomain, setResolvedDomain] = useState("");
  const [storeVerified, setStoreVerified] = useState(false);
  const [localError, setLocalError] = useState("");

  const urlError = searchParams.get("error");
  let error = localError;
  if (!error && urlError === "failed") {
    error = "Connection failed. Please try again.";
  } else if (!error && urlError === "missing") {
    error = "Please enter your store URL.";
  }

  const handleConnect = async () => {
    setLocalError("");
    if (!storeUrl.trim()) {
      setLocalError("Please enter your store URL.");
      return;
    }

    setIsResolving(true);

    try {
      const res = await fetch("/api/shopify/resolve-domain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: storeUrl }),
      });
      const data = await res.json();

      if (!data.isShopify) {
        setLocalError(data.error || "Could not verify store.");
        setIsResolving(false);
        return;
      }

      setResolvedDomain(data.myshopifyDomain);
      setStoreVerified(true);

      const fromParam = searchParams.get("from") ? `&from=${searchParams.get("from")}` : "";
      window.location.href = `/api/auth/shopify/connect?shop=${data.myshopifyDomain}${fromParam}`;
    } catch (err) {
      setLocalError("An error occurred while verifying the store.");
      setIsResolving(false);
    }
  };

  return (
    <div className="text-center">
      {/* Step indicator */}
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-500/10 border border-brand-500/20 mb-6 animate-fade-in-up">
        <span className="text-xs font-medium text-brand-400">
          Step 1 of 2
        </span>
      </div>

      {/* Heading */}
      <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-3 animate-fade-in-up-delay-1">
        Connect your
        <br />
        Shopify store
      </h1>
      <p className="text-sm text-white/50 leading-relaxed mb-8 max-w-xs mx-auto animate-fade-in-up-delay-2">
        Works with any Shopify store, anywhere in the world.
      </p>

      {/* Input */}
      <div className="mb-4 animate-fade-in-up-delay-2">
        <input
          suppressHydrationWarning
          id="shopify-url-input"
          type="text"
          value={storeUrl}
          onChange={(e) => setStoreUrl(e.target.value)}
          placeholder="yourstore.com or yourstore.myshopify.com"
          className="w-full px-4 py-3.5 rounded-xl bg-white/[0.04] border border-border-subtle text-white placeholder:text-white/25 text-sm focus:outline-none focus:border-brand-500/50 focus:ring-1 focus:ring-brand-500/20 transition-all duration-200"
        />
        <p className="text-xs text-white/30 mt-2">
          Enter your store URL in any format — we'll handle the rest.
        </p>
        {error && (
          <p className="mt-2 text-xs text-danger-400 text-left">{error}</p>
        )}
      </div>

      {/* CTA Button */}
      <button
        id="connect-shopify-btn"
        onClick={handleConnect}
        disabled={isResolving || storeVerified}
        className="group relative w-full py-4 px-6 rounded-xl font-semibold text-sm transition-all duration-300 animate-fade-in-up-delay-3 cursor-pointer disabled:cursor-not-allowed"
      >
        {/* Gradient background */}
        <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 transition-all duration-300 group-hover:from-brand-500 group-hover:to-brand-400 group-disabled:opacity-70" />

        {/* Glow effect */}
        <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-brand-500/20 blur-xl" />

        {/* Content */}
        <span className="relative flex items-center justify-center gap-2 text-white">
          {isResolving || storeVerified ? (
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
              <span>Verifying your store...</span>
            </>
          ) : (
            <>
              <span>Connect Store</span>
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
          await advanceOnboardingStep("audit");
          router.push("/onboarding/audit");
        }}
        className="text-xs text-white/30 hover:text-white/50 transition-colors mt-4 underline underline-offset-2"
      >
        Skip for now — I'll connect my store later
      </button>

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

export default function ConnectShopifyPage() {
  return (
    <Suspense fallback={<div className="text-center text-white/50">Loading...</div>}>
      <ConnectShopifyContent />
    </Suspense>
  );
}
