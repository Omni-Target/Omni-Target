"use client";

import React, { useEffect, useState, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useClerk, useAuth, ClerkLoaded, ClerkLoading } from "@clerk/nextjs";
import { Loader2, AlertCircle, ArrowRight } from "lucide-react";
import { Wordmark } from "@/components/shared/logo";
import { Button } from "@/components/ui/button";

function ShopifyCallbackContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const destination = searchParams.get("destination") || "/onboarding/audit";
  const { isSignedIn } = useAuth();
  const clerk = useClerk();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSlow, setIsSlow] = useState(false);
  const attemptedRef = useRef(false);

  useEffect(() => {
    // If merchant is already signed in, immediately forward them
    if (isSignedIn) {
      window.location.href = destination;
      return;
    }

    if (attemptedRef.current) return;
    attemptedRef.current = true;

    if (!token) {
      setErrorMsg("Authentication token is missing. Please try logging in again.");
      return;
    }

    // Safety timeout: if it takes more than 5s, provide an explicit continue option
    const timer = setTimeout(() => {
      setIsSlow(true);
    }, 5000);

    async function handleTicketAuth() {
      try {
        if (!clerk.client) throw new Error("Authentication service is not ready");

        const res = await clerk.client.signIn.create({
          strategy: "ticket",
          ticket: token as string,
        });

        if (res.status === "complete" && res.createdSessionId) {
          await clerk.setActive({ session: res.createdSessionId });
          window.location.href = destination;
        } else {
          console.warn("Clerk ticket status:", res.status);
          setErrorMsg("Authentication could not be completed automatically. Please sign in.");
        }
      } catch (err: unknown) {
        console.error("Shopify SSO authentication error:", err);
        const message =
          err instanceof Error ? err.message : "Failed to log in with Shopify.";
        setErrorMsg(message);
      } finally {
        clearTimeout(timer);
      }
    }

    handleTicketAuth();

    return () => {
      clearTimeout(timer);
    };
  }, [isSignedIn, token, destination, clerk]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface-subtle px-4 text-center">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-sm">
        <div className="flex justify-center mb-6">
          <Wordmark size={32} />
        </div>

        {errorMsg ? (
          <div className="space-y-4">
            <div className="mx-auto grid size-12 place-items-center rounded-full bg-danger-50 text-danger-600">
              <AlertCircle className="size-6" />
            </div>
            <h2 className="text-base font-semibold text-foreground">
              Sign-In Required
            </h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {errorMsg}
            </p>
            <Button
              className="w-full mt-2"
              onClick={() => (window.location.href = "/login")}
            >
              Go to login
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="mx-auto grid size-12 place-items-center rounded-full bg-brand-50 text-brand-600">
              <Loader2 className="size-6 animate-spin" />
            </div>
            <h2 className="text-base font-semibold text-foreground">
              Connecting your Shopify store
            </h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Verifying your store credentials and setting up your workspace…
            </p>

            {isSlow && (
              <div className="pt-3 border-t border-border/60">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-xs"
                  onClick={() => (window.location.href = destination)}
                >
                  Continue to workspace
                  <ArrowRight className="size-3.5 ml-1.5" />
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ShopifyCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen flex-col items-center justify-center bg-surface-subtle">
          <Loader2 className="size-8 animate-spin text-brand-600" />
        </div>
      }
    >
      <ClerkLoading>
        <div className="flex min-h-screen flex-col items-center justify-center bg-surface-subtle">
          <Loader2 className="size-8 animate-spin text-brand-600" />
        </div>
      </ClerkLoading>
      <ClerkLoaded>
        <ShopifyCallbackContent />
      </ClerkLoaded>
    </Suspense>
  );
}
