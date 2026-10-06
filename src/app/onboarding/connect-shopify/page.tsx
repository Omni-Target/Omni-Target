"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Lock, ShieldCheck, Loader2 } from "lucide-react";
import { useUser, useClerk } from "@clerk/nextjs";
import { OnboardingShell } from "@/components/onboarding";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { advanceOnboardingStep } from "../actions";
import { validateShopifyInput } from "@/lib/domain-validation";

import { ShopifyBagIcon } from "@/components/auth";

function ConnectShopifyContent() {
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [storeUrl, setStoreUrl] = useState("");
  const [isResolving, setIsResolving] = useState(false);
  const [storeVerified, setStoreVerified] = useState(false);
  const [localError, setLocalError] = useState("");

  const fromParam = searchParams.get("from");
  const isExplicitAction = fromParam === "dashboard" || fromParam === "pricing";

  const metadata = user?.publicMetadata as {
    shopifyStoreUrl?: string;
    onboardingStep?: string;
  } | undefined;

  const hasConnectedStore = !!metadata?.shopifyStoreUrl;

  useEffect(() => {
    if (!isLoaded || isExplicitAction) return;

    if (hasConnectedStore) {
      if (metadata?.onboardingStep === "complete") {
        router.replace("/dashboard");
      } else {
        router.replace("/onboarding/audit");
      }
    }
  }, [isLoaded, isExplicitAction, hasConnectedStore, metadata?.onboardingStep, router]);

  const urlError = searchParams.get("error");
  let error = localError;
  if (!error && urlError === "failed") {
    error = "Connection failed. Please try again.";
  } else if (!error && urlError === "missing") {
    error = "Please enter your store URL.";
  }

  const handleConnect = async () => {
    setLocalError("");
    const validation = validateShopifyInput(storeUrl);
    if (!validation.isValid) {
      setLocalError(
        validation.error ||
          "Please enter a valid domain (e.g., yourstore.com or store.myshopify.com)."
      );
      return;
    }

    setIsResolving(true);
    try {
      // Pre-flight verify that the store actually exists and is a valid Shopify storefront
      // This prevents nonexistent store subdomains from being redirected to Shopify's outage page
      const res = await fetch("/api/shopify/resolve-domain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: validation.normalized }),
      });
      const data = await res.json();

      if (!data.isShopify || !data.myshopifyDomain) {
        setLocalError(
          data.error ||
            "Could not verify a Shopify store at this domain. Please verify your store URL or enter your .myshopify.com address."
        );
        setIsResolving(false);
        return;
      }

      const myshopifyDomain = data.myshopifyDomain;
      setStoreVerified(true);
      const fromParam = searchParams.get("from")
        ? `&from=${searchParams.get("from")}`
        : "";
      let activePlan = searchParams.get("plan");
      if (!activePlan && typeof document !== "undefined") {
        const match = document.cookie.match(/(?:^|;\s*)selected_plan=([^;]+)/);
        if (match) activePlan = decodeURIComponent(match[1]);
      }
      const planParam = activePlan
        ? `&plan=${encodeURIComponent(activePlan)}`
        : "";
      window.location.href = `/api/auth/shopify/connect?shop=${encodeURIComponent(myshopifyDomain)}${fromParam}${planParam}`;
    } catch {
      setLocalError("An error occurred while verifying the store.");
      setIsResolving(false);
    }
  };

  if ((!isLoaded && !isExplicitAction) || (!isExplicitAction && hasConnectedStore)) {
    return (
      <OnboardingShell currentStep={1} contentClassName="max-w-md">
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Loader2 className="size-8 animate-spin text-brand-600 mb-4" />
          <h2 className="text-base font-semibold text-foreground">
            {hasConnectedStore ? "Redirecting to your workspace…" : "Loading…"}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {hasConnectedStore
              ? "Your Shopify store is already connected."
              : "Verifying account status…"}
          </p>
        </div>
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell currentStep={1} contentClassName="max-w-md">
      <div className="mb-7">
        <span className="inline-flex items-center gap-2 rounded-full border border-brand-100 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
          <ShopifyBagIcon className="size-3.5" />
          Step 1 of 2
        </span>
        <h1 className="mt-4 text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-foreground">
          Connect your Shopify store
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A secure integration to safely sync your live storefront metrics.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleConnect();
        }}
        className="space-y-4"
      >
        <Field
          label="Store URL"
          htmlFor="shopify-url-input"
          hint="Accepted formats: yourstore.com or store.myshopify.com"
          error={error || undefined}
        >
          <Input
            suppressHydrationWarning
            id="shopify-url-input"
            value={storeUrl}
            onChange={(e) => setStoreUrl(e.target.value)}
            placeholder="yourstore.com or store.myshopify.com"
            invalid={!!error}
            startIcon={<ShopifyBagIcon className="size-4" />}
          />
        </Field>

        <Button
          type="submit"
          size="lg"
          className="w-full"
          isLoading={isResolving || storeVerified}
        >
          {isResolving || storeVerified ? (
            "Verifying your store..."
          ) : (
            <>
              Connect store
              <ArrowRight className="size-4" />
            </>
          )}
        </Button>
      </form>

      {/* Account controls & exit recovery actions */}
      <div className="mt-5 rounded-lg border border-border-subtle bg-surface-subtle/60 p-3 text-xs text-muted-foreground">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate">
            Signed in as <strong className="font-medium text-foreground">{user?.primaryEmailAddress?.emailAddress || "Account"}</strong>
          </span>
          <button
            type="button"
            onClick={() => signOut({ redirectUrl: "/login" })}
            className="shrink-0 font-medium text-brand-600 hover:text-brand-700 hover:underline cursor-pointer"
          >
            Sign out
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-border-subtle/60 pt-2 text-[11px]">
          <span>Need to review or change plans?</span>
          <a
            href="https://omnitarget.co/pricing"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground hover:underline"
          >
            View pricing plans &rarr;
          </a>
        </div>
        {fromParam === "dashboard" && (
          <div className="mt-2 border-t border-border-subtle/60 pt-2 text-[11px] text-right">
            <button
              type="button"
              onClick={() => router.push("/dashboard")}
              className="text-muted-foreground hover:text-foreground hover:underline cursor-pointer"
            >
              &larr; Return to dashboard
            </button>
          </div>
        )}
      </div>

      <div className="mt-7 flex items-center justify-center gap-6 border-t border-border-subtle pt-5 text-xs text-subtle-foreground">
        <span className="flex items-center gap-1.5">
          <Lock className="size-3.5" />
          Read-only access
        </span>
        <span className="flex items-center gap-1.5">
          <ShieldCheck className="size-3.5" />
          Official Shopify Partner API
        </span>
      </div>
    </OnboardingShell>
  );
}

export default function ConnectShopifyPage() {
  return (
    <Suspense fallback={null}>
      <ConnectShopifyContent />
    </Suspense>
  );
}
