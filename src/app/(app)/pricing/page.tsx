"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  Sparkles,
  ShieldCheck,
  Zap,
  Infinity as InfinityIcon,
  HelpCircle,
} from "lucide-react";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
// Currency toggle disabled while Shopify Billing (USD) is the only payment method.
// import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { CreditPackCard, PurchaseDialog } from "@/components/pricing";
import { CREDIT_PACKS, type CreditPack } from "@/lib/credit-packs";

// Shopify Billing supports the starter/growth/scale plans only, so the
// single-brief pack is omitted from the storefront for now. The pack data
// remains in CREDIT_PACKS so it can be restored if another method returns.
const PURCHASABLE_PACKS = CREDIT_PACKS.filter((p) => p.id !== "single");

interface CreditsState {
  credits_balance: number;
  shop: string | null;
  is_unlimited: boolean;
}

const ASSURANCES = [
  { icon: ShieldCheck, title: "Secure checkout", body: "Billed safely through Shopify." },
  { icon: Zap, title: "Instant credits", body: "Briefs are added the moment you pay." },
  { icon: HelpCircle, title: "No subscription", body: "Buy credits once — they don't expire soon." },
];

function PricingContent() {
  const { toast } = useToast();
  const searchParams = useSearchParams();
  // Shopify Billing is USD-only, so the currency toggle is disabled for now.
  const currency = "USD" as const;
  const [state, setState] = React.useState<CreditsState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [selected, setSelected] = React.useState<CreditPack | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/user/credits")
      .then((r) => r.json())
      .then((d) => {
        setState({
          credits_balance: d.credits_balance ?? 0,
          shop: d.shop ?? null,
          is_unlimited: !!d.is_unlimited,
        });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    if (searchParams.get("status") === "cancelled") {
      toast({
        variant: "default",
        title: "Checkout cancelled",
        description: "No charge was made. You can pick a pack whenever you're ready.",
      });
      window.history.replaceState({}, "", "/pricing");
    }
  }, [searchParams, toast]);

  const onBuy = (pack: CreditPack) => {
    setSelected(pack);
    setDialogOpen(true);
  };

  return (
    <PageContainer width="wide" className="space-y-8 pb-16">
      <PageHeader
        eyebrow={
          <>
            <Sparkles className="size-3.5" /> Credits & billing
          </>
        }
        title="Buy campaign brief credits"
        description="Each credit generates one full AI campaign brief — copy, targeting, budget and a downloadable PDF. No subscription required."
      />

      {/* Current balance */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-surface px-5 py-4 shadow-xs">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-brand-50 text-brand-600">
            {state?.is_unlimited ? (
              <InfinityIcon className="size-5" />
            ) : (
              <Sparkles className="size-5" />
            )}
          </span>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-subtle-foreground">
              Current balance
            </p>
            {loading ? (
              <Skeleton className="mt-1 h-6 w-24" />
            ) : (
              <p className="text-lg font-semibold text-foreground">
                {state?.is_unlimited
                  ? "Unlimited access"
                  : `${state?.credits_balance ?? 0} credit${state?.credits_balance === 1 ? "" : "s"}`}
              </p>
            )}
          </div>
        </div>
        {state?.shop && (
          <p className="text-sm text-muted-foreground">
            Connected store ·{" "}
            <span className="font-medium text-foreground">{state.shop}</span>
          </p>
        )}
      </div>

      {/* Packs (single-brief omitted — see PURCHASABLE_PACKS note above) */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {PURCHASABLE_PACKS.map((pack) => (
          <CreditPackCard
            key={pack.id}
            pack={pack}
            currency={currency}
            onBuy={onBuy}
          />
        ))}
      </div>

      {/* Assurances */}
      <div className="grid gap-4 sm:grid-cols-3">
        {ASSURANCES.map(({ icon: Icon, title, body }) => (
          <div
            key={title}
            className="flex items-start gap-3 rounded-2xl border border-border-subtle bg-surface-subtle p-5"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface text-brand-600 shadow-xs">
              <Icon className="size-4.5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-foreground">{title}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{body}</p>
            </div>
          </div>
        ))}
      </div>

      <PurchaseDialog
        pack={selected}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        shop={state?.shop ?? null}
        currency={currency}
      />
    </PageContainer>
  );
}

export default function PricingPage() {
  return (
    <Suspense fallback={<PricingFallback />}>
      <PricingContent />
    </Suspense>
  );
}

function PricingFallback() {
  return (
    <PageContainer width="wide" className="space-y-8">
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-20 w-full" />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-96 w-full" />
        ))}
      </div>
    </PageContainer>
  );
}
