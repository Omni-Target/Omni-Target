"use client";

import React, { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { PageContainer } from "@/components/layout/page-container";
import { Section } from "@/components/layout/section";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Sparkles, ExternalLink } from "lucide-react";
import { BriefHistory } from "@/components/campaigns/brief-history";
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
import { useStoreData, useForceSyncStoreData } from "@/hooks/useStoreData";

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
  topProductName?: string,
): string {
  switch (readiness.readiness) {
    case "ready":
    case "ready_with_warnings":
      return topProductName
        ? `${topProductName} is your top Gateway product — proven to turn new shoppers into buyers. Your store is ready to launch ads.`
        : "You have winning Gateway products in stock and healthy buyer demand. Pick a product below to create your ad brief.";
    case "caution":
      return readiness.hasRecentOrders
        ? "Several of your best-selling styles are currently sold out. Restock your winners to start advertising."
        : "No recent orders detected yet. Share your store link or build initial sales before running paid ads.";
    default:
      return "We couldn't load your products. Sync or reconnect to refresh your store data.";
  }
}

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  // Store snapshot from the shared cache — deduped with the products & campaigns
  // pages, so navigating between them doesn't re-hit Shopify.
  const { data: storeResponse, isLoading: loading } = useStoreData();
  const forceSync = useForceSyncStoreData();
  const [refreshing, setRefreshing] = useState(false);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [shop, setShop] = useState<string | null>(null);

  const connected = storeResponse?.connected ?? false;
  const sessionExpired = !!storeResponse?.reauthRequired;
  const storeData =
    storeResponse?.connected && storeResponse.data ? storeResponse.data : null;

  if (storeResponse?.needsReauthForOrders && !needsReauth) {
    setNeedsReauth(true);
  }

  // Resolve connected shop domain (used by the not-connected state).
  useEffect(() => {
    fetch("/api/user/credits")
      .then((r) => r.json())
      .then((data) => setShop(data.shop))
      .catch(() => {});
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
        description:
          "Your briefs have been added. Let's create your first campaign brief.",
      });
      window.history.replaceState({}, "", "/dashboard");
    }
  }, [paymentSuccess, toast]);

  const billingMessage = searchParams.get("message");

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
    } else if (billingSuccess === "error") {
      // Surface callback failures — a silent error here previously made failed
      // credit grants indistinguishable from success.
      toast({
        variant: "danger",
        title: "Purchase issue",
        description:
          billingMessage?.replace(/\+/g, " ") ||
          "We couldn't confirm your purchase. If you were charged, contact support — your payment is safe.",
      });
      window.history.replaceState({}, "", "/dashboard");
    }
  }, [billingSuccess, billingCredits, billingPlan, billingMessage, toast]);

  const refreshStoreData = () => {
    setRefreshing(true);
    forceSync().finally(() => setRefreshing(false));
  };

  const onCreateBrief = (product: StoreProductLike, isNewLaunch: boolean) => {
    sessionStorage.setItem(
      "campaign_draft",
      JSON.stringify(buildCampaignDraft(product, isNewLaunch)),
    );
    router.push("/campaigns");
  };

  // --- Derivations (display-only) ---
  const store = (storeData?.store ?? {}) as {
    name?: string;
    currency?: string;
  };
  const products = (storeData?.products ?? []) as StoreProductLike[];
  const orders = (storeData?.orders ?? {}) as Parameters<
    typeof deriveInsights
  >[0];
  const currency = store.currency || "USD";

  const readiness = deriveAdReadiness(products, orders);
  const healthScore = deriveHealthScore(products, orders);
  const insights = deriveInsights(orders, currency);
  const locationText = deriveLocationText(orders);
  const peakDays = orders.peak_days || [];

  const isGatewayProduct = (p: StoreProductLike) =>
    p.gateway_classification?.toLowerCase() === "gateway";

  const outOfStockGateways = products.filter(
    (p) => !p.in_stock && isGatewayProduct(p),
  );

  const inStockProducts = products
    .filter((p) => p.in_stock && (p.units_sold ?? 0) > 0)
    .sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0));

  // Combine out-of-stock Gateway champions with top in-stock performers
  // Prioritize Gateway champions (both in-stock and out-of-stock) by revenue
  const intelligenceProducts = [...outOfStockGateways, ...inStockProducts]
    .sort((a, b) => {
      const aG = isGatewayProduct(a);
      const bG = isGatewayProduct(b);
      if (aG && !bG) return -1;
      if (!aG && bG) return 1;
      return (b.revenue ?? 0) - (a.revenue ?? 0);
    })
    .slice(0, 6);

  const topInStockProduct =
    intelligenceProducts.find((p) => p.in_stock)?.name ||
    intelligenceProducts[0]?.name;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const newLaunches = products
    .filter((p) => {
      const orderCount = p.order_count ?? p.units_sold ?? 0;
      const isRecentAndLow =
        p.created_at &&
        new Date(p.created_at) >= thirtyDaysAgo &&
        orderCount < 3;
      return p.in_stock && (isRecentAndLow || orderCount === 0);
    })
    .slice(0, 6);

  const restocking = products
    .filter(
      (p) =>
        !p.in_stock &&
        (p.units_sold ?? 0) > 0 &&
        !isGatewayProduct(p),
    )
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
            lastSynced={relativeTime(
              storeData?.generated_at as string | undefined,
            )}
            readiness={readiness.readiness}
            subtext={readinessSubtext(readiness, topInStockProduct)}
            healthScore={healthScore}
            onSync={refreshStoreData}
            syncing={refreshing}
            topProduct={topInStockProduct}
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
              <Section
                title="Tips for your next ad"
                description="Recommendations based on your store's recent sales and customer habits"
              >
                {insights.length > 0 ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {insights.map((insight, i) => (
                      <InsightCard key={i} insight={insight} />
                    ))}
                  </div>
                ) : (
                  <div className="grid h-full place-items-center rounded-2xl border border-dashed border-border bg-surface-subtle p-8 text-center text-sm text-muted-foreground">
                    More tips unlock as your store gathers order data.
                  </div>
                )}
              </Section>
            </div>
          </div>

          <Section
            title="Products to advertise"
            description="Your top Gateway products and best performers, ranked for ad readiness"
          >
            {outOfStockGateways.length > 0 && (
              <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-amber-300/80 bg-linear-to-r from-amber-500/10 via-amber-500/5 to-transparent p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-100 text-amber-800">
                    <Sparkles className="size-5" />
                  </span>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-foreground">
                        Restock Suggestion: {outOfStockGateways.map((g) => g.name).join(", ")}
                      </p>
                      <Badge variant="brand" size="sm">
                        Gateway Hero
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {outOfStockGateways.length === 1
                        ? `95% of people who bought this were brand new to your store (${outOfStockGateways[0].units_sold} sold). Restocking this Gateway Product on Shopify lets you start attracting new shoppers again.`
                        : "These Gateway Products are your best tools for winning new customers. Restock them on Shopify to start attracting new shoppers again."}
                    </p>
                  </div>
                </div>
                {shop && (
                  <Button
                    size="sm"
                    variant="outline"
                    asChild
                    className="shrink-0 border-amber-300 text-amber-900 hover:bg-amber-100"
                  >
                    <a
                      href={
                        outOfStockGateways.length === 1
                          ? `https://${shop}/admin/products/${outOfStockGateways[0].id}`
                          : `https://${shop}/admin/products`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 font-semibold"
                    >
                      Restock on Shopify
                      <ExternalLink className="size-3.5" />
                    </a>
                  </Button>
                )}
              </div>
            )}

            {intelligenceProducts.length > 0 ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {intelligenceProducts.map((p) => (
                  <ProductIntelCard
                    key={String(p.id)}
                    product={p}
                    currency={currency}
                    variant="intelligence"
                    onCreateBrief={onCreateBrief}
                    shop={shop}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-border bg-surface-subtle p-8 text-center text-sm text-muted-foreground">
                No in-stock products to advertise yet. Restock your winners
                below.
              </div>
            )}
          </Section>

          {newLaunches.length > 0 && (
            <Section
              title="New arrivals"
              description="Recently added to your store — create an ad brief to introduce them to shoppers"
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {newLaunches.map((p) => (
                  <ProductIntelCard
                    key={`new-${p.id}`}
                    product={p}
                    currency={currency}
                    variant="new-launch"
                    onCreateBrief={onCreateBrief}
                    shop={shop}
                  />
                ))}
              </div>
            </Section>
          )}

          <BriefHistory />

          <RestockingPanel products={restocking} currency={currency} shop={shop} />
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
