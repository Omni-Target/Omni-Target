"use client";

import React, { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { PageContainer } from "@/components/layout/page-container";
import { Section } from "@/components/layout/section";
import { Alert } from "@/components/ui/alert";
import { useToast } from "@/components/ui/toast";
import {
  CommandCenterHero,
  KpiRow,
  BuyerProfile,
  InsightCard,
  ProductIntelCard,
  RestockingPanel,
  DashboardSkeleton,
  ConnectStoreState,
  deriveAdReadiness,
  deriveHealthScore,
  deriveInsights,
  deriveLocationText,
  buildCampaignDraft,
  type StoreProductLike,
} from "@/components/dashboard";

interface StoreDataResponse {
  connected: boolean;
  data?: Record<string, unknown> | null;
  needsReauthForOrders?: boolean;
  // Set when the Shopify refresh token is dead and the store must reconnect.
  reauthRequired?: boolean;
}

function relativeTime(iso?: string): string {
  if (!iso) return "just now";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function readinessSubtext(
  readiness: ReturnType<typeof deriveAdReadiness>,
): string {
  switch (readiness.readiness) {
    case "ready":
      return "Active products, recent sales — everything Meta needs to start learning. Let's run something.";
    case "ready_with_warnings":
      return "Check Product Intelligence below — we've flagged the best products to run right now.";
    case "caution":
      return readiness.hasRecentOrders
        ? "Most of your stock is out. Restock your winners and you'll be ready to go."
        : "No recent orders yet. Build some organic momentum first, then come back.";
    default:
      return "We couldn't load your products. Sync or reconnect to refresh your store data.";
  }
}

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  const [storeData, setStoreData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connected, setConnected] = useState(false);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [shop, setShop] = useState<string | null>(null);

  // Resolve connected shop domain (used by the not-connected state).
  useEffect(() => {
    fetch("/api/user/credits")
      .then((r) => r.json())
      .then((data) => setShop(data.shop))
      .catch(() => {});
  }, []);

  // Initial store data load.
  useEffect(() => {
    fetch("/api/store/data", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: StoreDataResponse) => {
        setConnected(data.connected);
        setSessionExpired(!!data.reauthRequired);
        if (data.needsReauthForOrders) setNeedsReauth(true);
        if (data.connected && data.data) setStoreData(data.data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Success toasts from redirect params.
  const paymentSuccess = searchParams.get("payment");
  const billingSuccess = searchParams.get("billing");
  const billingCredits = searchParams.get("credits");
  const billingPlan = searchParams.get("plan");

  useEffect(() => {
    if (paymentSuccess === "success") {
      toast({
        variant: "success",
        title: "Payment successful",
        description: "Your briefs have been added. Let's create your first campaign brief.",
      });
      window.history.replaceState({}, "", "/dashboard");
    }
  }, [paymentSuccess, toast]);

  useEffect(() => {
    if (billingSuccess === "success") {
      toast({
        variant: "success",
        title: "Billing successful",
        description: `Added ${billingCredits} credits via Shopify${
          billingPlan ? ` for the ${billingPlan} Pack` : ""
        }.`,
      });
      window.history.replaceState({}, "", "/dashboard");
    }
  }, [billingSuccess, billingCredits, billingPlan, toast]);

  const refreshStoreData = () => {
    setRefreshing(true);
    fetch("/api/store/data?force=true", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: StoreDataResponse) => {
        setConnected(data.connected);
        setSessionExpired(!!data.reauthRequired);
        if (data.needsReauthForOrders) setNeedsReauth(true);
        if (data.connected && data.data) setStoreData(data.data);
        setRefreshing(false);
      })
      .catch(() => setRefreshing(false));
  };

  const onCreateBrief = (product: StoreProductLike, isNewLaunch: boolean) => {
    sessionStorage.setItem(
      "campaign_draft",
      JSON.stringify(buildCampaignDraft(product, isNewLaunch)),
    );
    router.push("/campaigns");
  };

  // --- Derivations (display-only) ---
  const store = (storeData?.store ?? {}) as { name?: string; currency?: string };
  const products = (storeData?.products ?? []) as StoreProductLike[];
  const orders = (storeData?.orders ?? {}) as Parameters<typeof deriveInsights>[0];
  const currency = store.currency || "USD";

  const readiness = deriveAdReadiness(products, orders);
  const healthScore = deriveHealthScore(products, orders);
  const insights = deriveInsights(orders);
  const locationText = deriveLocationText(orders);
  const peakDays = orders.peak_days || [];

  const intelligenceProducts = products
    .filter((p) => p.in_stock)
    .sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))
    .slice(0, 6);

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const newLaunches = products
    .filter((p) => {
      const orderCount = p.order_count ?? p.units_sold ?? 0;
      const isRecentAndLow =
        p.created_at && new Date(p.created_at) >= thirtyDaysAgo && orderCount < 3;
      return p.in_stock && (isRecentAndLow || orderCount === 0);
    })
    .slice(0, 6);

  const restocking = products
    .filter((p) => !p.in_stock && (p.units_sold ?? 0) > 0)
    .sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0));

  return (
    <PageContainer width="wide" className="space-y-8 pb-24 lg:pb-10">
      {loading ? (
        <DashboardSkeleton />
      ) : !connected ? (
        <ConnectStoreState shop={shop} expired={sessionExpired} />
      ) : (
        <>
          <CommandCenterHero
            storeName={store.name || "Your store"}
            lastSynced={relativeTime(storeData?.generated_at as string | undefined)}
            readiness={readiness.readiness}
            subtext={readinessSubtext(readiness)}
            healthScore={healthScore}
            onSync={refreshStoreData}
            syncing={refreshing}
          />

          {needsReauth && (
            <Alert variant="brand" title="Unlock full order history">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span>
                  Full order history gives you more accurate recommendations. We
                  recently updated our permissions.
                </span>
                <Link
                  href="/api/auth/shopify/connect?from=dashboard"
                  className="shrink-0 rounded-lg bg-brand-600 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-brand-700"
                >
                  Reconnect store
                </Link>
              </div>
            </Alert>
          )}

          <KpiRow
            revenue30d={orders.revenue_last_30_days}
            orders30d={orders.orders_last_30_days ?? 0}
            aov={orders.average_order_value ?? 0}
            repeatRate={orders.repeat_customer_rate ?? 0}
            activeProducts={products.filter((p) => p.in_stock).length}
            totalProducts={products.length}
            currency={currency}
          />

          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-1">
              <BuyerProfile
                locationText={locationText}
                peakDays={peakDays}
                aov={orders.average_order_value ?? 0}
                repeatRate={orders.repeat_customer_rate ?? 0}
                currency={currency}
              />
            </div>
            <div className="lg:col-span-2">
              <Section title="What this means for your ads">
                {insights.length > 0 ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {insights.map((insight, i) => (
                      <InsightCard key={i} insight={insight} />
                    ))}
                  </div>
                ) : (
                  <div className="grid h-full place-items-center rounded-2xl border border-dashed border-border bg-surface-subtle p-8 text-center text-sm text-muted-foreground">
                    More insights unlock as your store gathers order data.
                  </div>
                )}
              </Section>
            </div>
          </div>

          <Section
            title="Product intelligence"
            description="The best products to advertise right now, ranked by revenue."
          >
            {intelligenceProducts.length > 0 ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {intelligenceProducts.map((p) => (
                  <ProductIntelCard
                    key={String(p.id)}
                    product={p}
                    currency={currency}
                    variant="intelligence"
                    onCreateBrief={onCreateBrief}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-border bg-surface-subtle p-8 text-center text-sm text-muted-foreground">
                No in-stock products to advertise yet. Restock your winners below.
              </div>
            )}
          </Section>

          {newLaunches.length > 0 && (
            <Section
              title="New launches"
              description="Just added — build a launch brief before the first sale."
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {newLaunches.map((p) => (
                  <ProductIntelCard
                    key={`new-${p.id}`}
                    product={p}
                    currency={currency}
                    variant="new-launch"
                    onCreateBrief={onCreateBrief}
                  />
                ))}
              </div>
            </Section>
          )}

          <RestockingPanel products={restocking} currency={currency} />
        </>
      )}
    </PageContainer>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardFallback />}>
      <DashboardContent />
    </Suspense>
  );
}

function DashboardFallback() {
  return (
    <PageContainer width="wide" className="space-y-8">
      <DashboardSkeleton />
    </PageContainer>
  );
}
