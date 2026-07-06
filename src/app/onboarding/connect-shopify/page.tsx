"use client";

import React, { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Lock, Store, Users } from "lucide-react";
import { OnboardingShell } from "@/components/onboarding";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { advanceOnboardingStep } from "../actions";

function ConnectShopifyContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [storeUrl, setStoreUrl] = useState("");
  const [isResolving, setIsResolving] = useState(false);
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

      setStoreVerified(true);
      const fromParam = searchParams.get("from")
        ? `&from=${searchParams.get("from")}`
        : "";
      window.location.href = `/api/auth/shopify/connect?shop=${data.myshopifyDomain}${fromParam}`;
    } catch {
      setLocalError("An error occurred while verifying the store.");
      setIsResolving(false);
    }
  };

  const handleSkip = async () => {
    await advanceOnboardingStep("audit");
    router.push("/onboarding/audit");
  };

  return (
    <OnboardingShell currentStep={1} contentClassName="max-w-md">
      <div className="mb-7">
        <span className="inline-flex items-center gap-2 rounded-full border border-brand-100 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
          <Store className="size-3.5" />
          Step 1 of 2
        </span>
        <h1 className="mt-4 text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-foreground">
          Connect your Shopify store
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A secure integration to safely sync yout live storefront metrics.
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
          hint="Enter your store URL - We'll handle the authentication."
          error={error || undefined}
        >
          <Input
            suppressHydrationWarning
            id="shopify-url-input"
            value={storeUrl}
            onChange={(e) => setStoreUrl(e.target.value)}
            placeholder="yourstore.com or yourstore.myshopify.com"
            invalid={!!error}
            startIcon={<Store />}
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

      <button
        onClick={handleSkip}
        className="mx-auto mt-4 block text-xs font-medium text-subtle-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
      >
        Skip for now — I&apos;ll connect my store later
      </button>

      <div className="mt-8 flex items-center justify-center gap-6 border-t border-border-subtle pt-6 text-xs text-subtle-foreground">
        <span className="flex items-center gap-1.5">
          <Lock className="size-3.5" />
          Read-only access
        </span>
        <span className="flex items-center gap-1.5">
          <Users className="size-3.5" />
          2,400+ merchants
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
