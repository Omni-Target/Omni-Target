"use client";

import * as React from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import {
  CreditCard,
  ShoppingBag,
  Smartphone,
  ChevronRight,
  Store,
} from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn, formatCurrency } from "@/lib/utils";
import type { CreditPack } from "@/lib/credit-packs";

type Method = "card" | "shopify" | "paystack";

export interface PurchaseDialogProps {
  pack: CreditPack | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shop: string | null;
  currency: "USD" | "NGN";
}

export function PurchaseDialog({
  pack,
  open,
  onOpenChange,
  shop,
}: PurchaseDialogProps) {
  // NOTE: `useUser` is retained for the (currently disabled) Paystack flow.
  const { user } = useUser();
  const { toast } = useToast();
  const [pending, setPending] = React.useState<Method | null>(null);

  if (!pack) return null;

  const email = user?.primaryEmailAddress?.emailAddress ?? "";
  // Shopify Billing supports the starter/growth/scale plans for connected stores.
  const shopifyAvailable = !!shop && pack.id !== "single" && pack.id !== "free";

  async function start(method: Method) {
    if (!pack) return;
    setPending(method);
    try {
      let url: string | undefined;
      if (method === "card") {
        // --- Stripe (temporarily disabled — preserved for future re-enable) ---
        const res = await fetch("/api/payments/stripe/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ packId: pack.id }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Checkout failed");
        url = data.url;
      } else if (method === "shopify") {
        const res = await fetch("/api/shopify/billing/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shop, plan: pack.id }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Billing failed");
        url = data.confirmationUrl;
      } else {
        // --- Paystack (temporarily disabled — preserved for future re-enable) ---
        const res = await fetch("/api/payments/paystack/initiate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ packId: pack.id, email }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Payment failed");
        url = data.authorization_url;
      }
      if (url) {
        window.location.assign(url);
      } else {
        throw new Error("No redirect URL returned");
      }
    } catch (err) {
      setPending(null);
      toast({
        variant: "danger",
        title: "Couldn't start checkout",
        description: err instanceof Error ? err.message : "Please try again.",
      });
    }
  }

  const methods: Array<{
    id: Method;
    icon: React.ElementType;
    title: string;
    subtitle: string;
    amount: string;
  }> = [
    {
      id: "shopify",
      icon: ShoppingBag,
      title: "Pay with Shopify",
      subtitle: "Charged securely through your Shopify account",
      amount: formatCurrency(pack.price_usd, "$"),
    },
    /* ---------------------------------------------------------------------
     * Stripe & Paystack are temporarily disabled — Shopify Billing is the
     * single active payment method. The API routes and the `start()` branches
     * above remain intact; re-enable by restoring these entries.
     * ---------------------------------------------------------------------
    {
      id: "card",
      icon: CreditCard,
      title: "Pay with card",
      subtitle: "Secure checkout via Stripe",
      amount: formatCurrency(pack.price_usd, "$"),
    },
    {
      id: "paystack",
      icon: Smartphone,
      title: "Pay with Paystack",
      subtitle: "Card, bank transfer or USSD",
      amount: formatCurrency(pack.price_ngn, "₦"),
    },
    --------------------------------------------------------------------- */
  ];

  // Reference disabled icons so imports stay valid while providers are off.
  void CreditCard;
  void Smartphone;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !pending && onOpenChange(v)}
      title={`Get ${pack.name}`}
      description={`${pack.credits} campaign ${pack.credits === 1 ? "brief" : "briefs"} · ${formatCurrency(pack.price_usd, "$")} one-time`}
      size="md"
    >
      {!shopifyAvailable ? (
        <Alert variant="brand" title="Connect your Shopify store" icon={<Store className="size-4.5" />}>
          <p className="mt-1">
            Credits are billed securely through Shopify. Connect your store to
            complete this purchase.
          </p>
          <Button asChild size="sm" className="mt-3">
            <Link href="/onboarding/connect-shopify?from=pricing">
              Connect store
            </Link>
          </Button>
        </Alert>
      ) : (
        <div className="space-y-2.5">
          {methods.map((m) => {
            const isPending = pending === m.id;
            const Icon = m.icon;
            return (
              <button
                key={m.id}
                type="button"
                disabled={!!pending}
                onClick={() => start(m.id)}
                className={cn(
                  "flex w-full items-center gap-3.5 rounded-xl border p-3.5 text-left transition-all duration-150",
                  "border-border bg-surface hover:border-brand-300 hover:bg-surface-subtle",
                  isPending && "border-brand-400 bg-surface-subtle",
                )}
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-foreground">
                    {m.title}
                  </span>
                  <span className="block truncate text-xs text-subtle-foreground">
                    {m.subtitle}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-semibold text-foreground">
                  {m.amount}
                </span>
                {isPending ? (
                  <Spinner size="sm" />
                ) : (
                  <ChevronRight className="size-4 shrink-0 text-faint-foreground" />
                )}
              </button>
            );
          })}
        </div>
      )}
      <p className="mt-4 text-center text-xs text-faint-foreground">
        Payments are processed securely. You&apos;ll be redirected to complete
        checkout.
      </p>
    </Dialog>
  );
}
