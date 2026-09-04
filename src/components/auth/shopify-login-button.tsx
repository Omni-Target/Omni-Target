"use client";

import React, { useState, useEffect } from "react";
import { ArrowRight, Loader2, Store, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ShopifyBagIcon({ className = "size-5" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="15 308 136 172"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fill="#95BF47"
        d="M131.5 341.9c-.1-.9-.9-1.3-1.5-1.3s-13.7-1-13.7-1-9.1-9.1-10.2-10c-1-1-2.9-.7-3.7-.5-.1 0-2 .6-5.1 1.6-3.1-8.9-8.4-17-17.9-17h-.9c-2.6-3.4-6-5-8.8-5-22 0-32.6 27.5-35.9 41.5-8.6 2.7-14.7 4.5-15.4 4.8-4.8 1.5-4.9 1.6-5.5 6.1-.5 3.4-13 100.1-13 100.1l97.3 18.2L150 468c.1-.2-18.4-125.2-18.5-126.1zm-39.6-9.8c-2.4.7-5.3 1.6-8.2 2.6v-1.8c0-5.4-.7-9.8-2-13.3 5 .6 8.1 6.1 10.2 12.5zm-16.3-11.4c1.3 3.4 2.2 8.2 2.2 14.8v1c-5.4 1.7-11.1 3.4-17 5.3 3.3-12.6 9.6-18.8 14.8-21.1zm-6.4-6.2c1 0 2 .4 2.8 1-7.1 3.3-14.6 11.6-17.7 28.4-4.7 1.5-9.2 2.8-13.5 4.2 3.6-12.8 12.6-33.6 28.4-33.6z"
      />
      <path
        fill="#5E8E3E"
        d="M130 340.4c-.6 0-13.7-1-13.7-1s-9.1-9.1-10.2-10c-.4-.4-.9-.6-1.3-.6l-7.3 150.6 52.8-11.4s-18.5-125.2-18.6-126.1c-.4-.9-1.1-1.3-1.7-1.5z"
      />
      <path
        fill="#FFFFFF"
        d="M79.4 369.6L73 388.9s-5.8-3.1-12.7-3.1c-10.3 0-10.8 6.5-10.8 8.1 0 8.8 23 12.2 23 32.9 0 16.3-10.3 26.8-24.2 26.8-16.8 0-25.2-10.4-25.2-10.4l4.5-14.8s8.8 7.6 16.2 7.6c4.9 0 6.9-3.8 6.9-6.6 0-11.5-18.8-12-18.8-31 0-15.9 11.4-31.3 34.5-31.3 8.6-.1 13 2.5 13 2.5z"
      />
    </svg>
  );
}

export function ShopifyLoginButton() {
  const [isExpanded, setIsExpanded] = useState(false);
  const [storeDomain, setStoreDomain] = useState("");
  const [savedStore, setSavedStore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const lastStore = localStorage.getItem("omni_last_shopify_store");
      if (lastStore) {
        setSavedStore(lastStore);
        setStoreDomain(lastStore.replace(/\.myshopify\.com$/i, ""));
      }
    } catch {
      // localStorage may be unavailable in private browsing
    }
  }, []);

  const handleInitiate = (shopToUse?: string) => {
    const raw = (shopToUse || storeDomain).trim();
    if (!raw) {
      setError("Please enter your website or store URL.");
      return;
    }

    setError(null);
    setLoading(true);

    try {
      localStorage.setItem("omni_last_shopify_store", raw);
    } catch {
      // ignore
    }

    // Direct to the public connect endpoint — backend resolves custom domains & myshopify URLs automatically
    window.location.href = `/api/auth/shopify/connect?shop=${encodeURIComponent(
      raw
    )}&from=login`;
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleInitiate();
  };

  // If we have a saved store and user hasn't toggled to enter a new one
  if (savedStore && !isExpanded) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          disabled={loading}
          onClick={() => handleInitiate(savedStore)}
          className="group relative flex h-11 w-full items-center justify-center gap-3 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-foreground shadow-xs transition-all hover:border-foreground/30 hover:bg-surface-subtle active:scale-[0.99] disabled:opacity-60 cursor-pointer"
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin text-brand-600" />
          ) : (
            <ShopifyBagIcon className="size-5 shrink-0" />
          )}
          <span>
            {loading
              ? `Connecting to ${savedStore}…`
              : `Continue as ${savedStore.replace(/\.myshopify\.com$/i, "")}`}
          </span>
          <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 ml-auto" />
        </button>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setIsExpanded(true)}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            Use a different store
          </button>
        </div>
      </div>
    );
  }

  // Expanded inline input (Apple-style smooth sheet)
  if (isExpanded) {
    return (
      <form
        onSubmit={handleFormSubmit}
        className="rounded-xl border border-brand-200/80 bg-brand-50/40 p-3.5 space-y-3 shadow-xs transition-all"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <ShopifyBagIcon className="size-4" />
            <span>Enter your store website</span>
          </div>
          {savedStore && (
            <button
              type="button"
              onClick={() => {
                setIsExpanded(false);
                setError(null);
              }}
              className="text-muted-foreground hover:text-foreground cursor-pointer p-0.5"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <div className="relative flex items-center">
          <input
            type="text"
            autoFocus
            disabled={loading}
            placeholder="yourstore.com or store.myshopify.com"
            value={storeDomain}
            onChange={(e) => {
              setStoreDomain(e.target.value);
              if (error) setError(null);
            }}
            className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-brand-500 focus:outline-hidden focus:ring-2 focus:ring-brand-500/20 transition-all"
          />
        </div>

        {error && <p className="text-[11px] text-danger-600 font-medium">{error}</p>}

        <Button
          type="submit"
          disabled={loading || !storeDomain.trim()}
          className="h-9 w-full text-xs font-medium bg-[#111213] text-white hover:bg-black"
        >
          {loading ? (
            <>
              <Loader2 className="size-3.5 animate-spin mr-1.5" />
              Connecting to store…
            </>
          ) : (
            <>
              Continue with Shopify
              <ArrowRight className="size-3.5 ml-1.5" />
            </>
          )}
        </Button>
      </form>
    );
  }

  // Default initial button (Single 1-click Apple/Google style)
  return (
    <button
      type="button"
      disabled={loading}
      onClick={() => setIsExpanded(true)}
      className="group relative flex h-11 w-full items-center justify-center gap-3 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-foreground shadow-xs transition-all hover:border-foreground/30 hover:bg-surface-subtle active:scale-[0.99] disabled:opacity-60 cursor-pointer"
    >
      <ShopifyBagIcon className="size-5 shrink-0" />
      <span>Continue with Shopify</span>
      <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 ml-auto" />
    </button>
  );
}
