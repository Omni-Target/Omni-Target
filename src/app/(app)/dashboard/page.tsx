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
import { useCredits, CREDITS_QUERY_KEY } from "@/hooks/useCredits";
import { useQueryClient } from "@tanstack/react-query";
import { PurchaseDialog } from "@/components/pricing";
import { getPackById, type CreditPack } from "@/lib/credit-packs";
import { compareProductsForTest } from "@/lib/gateway-decision";
import type { StorePrespendIntelligence } from "@/lib/store-data";
import { isFallbackCountryEntry } from "@/lib/market-geography";

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
        ? `${topProductName} has your strongest first-order purchase signal. It is a high-priority cold-acquisition test candidate.`
        : "You have in-stock products with strong first-order purchase signals. Pick one below to create an ad brief.";
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
  const queryClient = useQueryClient();
  const { shop: creditsShop } = useCredits();

  // Store snapshot from the shared cache — deduped with the products & campaigns
  // pages, so navigating between them doesn't re-hit Shopify.
  const { data: storeResponse, isLoading: loading } = useStoreData();
  const forceSync = useForceSyncStoreData();
  const [refreshing, setRefreshing] = useState(false);
  const [shop, setShop] = useState<string | null>(null);
  const reconnectSyncStarted = React.useRef(false);
  const shopifyReconnected = searchParams.get("shopify") === "reconnected";

  const connected = storeResponse?.connected ?? false;
  const sessionExpired = !!storeResponse?.reauthRequired;
  const storeData =
    storeResponse?.connected && storeResponse.data ? storeResponse.data : null;

  const needsReauth = !shopifyReconnected && !refreshing && Boolean(
    storeResponse?.needsShopifyReauthorization ||
      storeResponse?.needsReauthForOrders,
  );

  useEffect(() => {
    if (!shopifyReconnected || reconnectSyncStarted.current) return;
    reconnectSyncStarted.current = true;
    forceSync()
      .catch(() => toast({
        variant: "danger",
        title: "Store refresh failed",
        description: "Your store is connected. Use Refresh data to try the sync again.",
      }))
      .finally(() => {
        const url = new URL(window.location.href);
        url.searchParams.delete("shopify");
        window.history.replaceState({}, "", `${url.pathname}${url.search}`);
      });
  }, [shopifyReconnected, forceSync, toast]);

  // Resolve connected shop domain (only needed if store is not connected).
  useEffect(() => {
    if (connected) return;
    if (creditsShop) {
      setShop(creditsShop);
    }
  }, [connected, creditsShop]);

  // Success toasts from redirect params.
  const paymentSuccess = searchParams.get("payment");
  const billingSuccess = searchParams.get("billing");
  const billingCredits = searchParams.get("credits");
  const billingPlan = searchParams.get("plan");

  useEffect(() => {
    if (paymentSuccess === "success") {
      queryClient.invalidateQueries({ queryKey: CREDITS_QUERY_KEY });
      toast({
        variant: "success",
        title: "Payment successful",
        description:
          "Your briefs have been added. Let's create your first campaign brief.",
      });
      window.history.replaceState({}, "", "/dashboard");
    }
  }, [paymentSuccess, toast, queryClient]);

  const billingMessage = searchParams.get("message");

  const planParam = searchParams.get("plan")?.toLowerCase();
  const initialPlanPack = React.useMemo(() => {
    if (billingSuccess) return null;
    if (planParam && ["starter", "growth", "scale"].includes(planParam)) {
      return getPackById(planParam) ?? null;
    }
    return null;
  }, [planParam, billingSuccess]);

  const [pendingPlanPack, setPendingPlanPack] = useState<CreditPack | null>(initialPlanPack);
  const [purchaseDialogOpen, setPurchaseDialogOpen] = useState(Boolean(initialPlanPack));

  useEffect(() => {
    if (initialPlanPack) {
      if (typeof document !== "undefined") {
        document.cookie = "selected_plan=; Path=/; Max-Age=0";
      }
      window.history.replaceState({}, "", "/dashboard");
    }
  }, [initialPlanPack]);

  useEffect(() => {
    if (billingSuccess === "success") {
      queryClient.invalidateQueries({ queryKey: CREDITS_QUERY_KEY });
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
  }, [billingSuccess, billingCredits, billingPlan, billingMessage, toast, queryClient]);

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
    domain?: string;
  };
  const activeShop = store.domain || shop;
  const products = (storeData?.products ?? []) as StoreProductLike[];
  const orders = (storeData?.orders ?? {}) as Parameters<
    typeof deriveInsights
  >[0];
  const currency = store.currency || "USD";

  const readiness = deriveAdReadiness(products, orders);
  const healthScore = deriveHealthScore(products, orders);
  const prespend = storeData?.prespend as StorePrespendIntelligence | undefined;
  const insights = deriveInsights(orders, currency, prespend?.analytics?.recent_funnel);
  const locationText = deriveLocationText(orders);
  const locationLevel = orders.top_locations?.some((loc) => !isFallbackCountryEntry(loc))
    ? "city" as const
    : (orders.top_order_countries?.length || orders.top_locations?.length)
      ? "commercial_hubs" as const
      : "missing" as const;
  const peakDays = orders.peak_days || [];

  const isGatewayProduct = (p: StoreProductLike) =>
    p.gateway_classification?.toLowerCase() === "gateway";

  const outOfStockGateways = products.filter(
    (p) => !p.in_stock && isGatewayProduct(p),
  );

  const inStockProducts = products
    .filter((p) => p.in_stock && (p.units_sold ?? 0) > 0)
    .sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0));

  // Historical product role and current test readiness are independent.
  const intelligenceProducts = [...outOfStockGateways, ...inStockProducts]
    .sort(compareProductsForTest)
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
          {pendingPlanPack && (
            <div className="flex flex-col gap-3 rounded-2xl border border-brand-200 bg-brand-50/80 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5 shadow-xs animate-fade-in">
              <div className="flex items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-700">
                  <Sparkles className="size-5" />
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">
                      You selected the {pendingPlanPack.name}
                    </p>
                    <Badge variant="brand" size="sm">
                      Selected Plan
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Authorize via Shopify to activate {pendingPlanPack.credits} Creative Briefs and start generating high-converting ads.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  size="sm"
                  onClick={() => setPurchaseDialogOpen(true)}
                  className="font-semibold"
                >
                  Activate via Shopify
                </Button>
                <button
                  type="button"
                  onClick={() => setPendingPlanPack(null)}
                  className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 cursor-pointer transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          <CommandCenterHero
            storeName={store.name || "Your store"}
            lastSynced={relativeTime(
              storeData?.generated_at as string | undefined,
            )}
            readiness={readiness.readiness}
            subtext={readinessSubtext(readiness, topInStockProduct)}
            healthScore={healthScore}
            onSync={refreshStoreData}
            syncing={refreshing || shopifyReconnected}
            topProduct={topInStockProduct}
          />

          {needsReauth && (
            <Alert variant="brand" title="Unlock upgraded store intelligence">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span>
                  Reconnect once so Omni Target can read the new analytics,
                  cost, inventory, market, shipping, return, discount, and
                  policy signals used by the upgraded recommendations.
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
                locationLevel={locationLevel}
                peakDays={peakDays}
                aov={orders.average_order_value ?? 0}
                repeatRate={orders.repeat_customer_rate ?? 0}
                currency={currency}
                topChannel={orders.acquisition_channels?.[0]?.channel}
                topChannelPercentage={orders.acquisition_channels?.[0]?.percentage}
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
            description="First-order product signals and current test readiness, shown separately"
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
                        Gateway signal
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {outOfStockGateways.length === 1
                        ? `${outOfStockGateways[0].product_decision?.first_order_count ?? "Some"} identified first orders contained this product. Its first-order role remains visible, but the stock check puts an ad test on hold.`
                        : "These products have first-order signals, but their current stock puts an ad test on hold."}
                    </p>
                  </div>
                </div>
                {activeShop && (
                  <Button
                    size="sm"
                    variant="outline"
                    asChild
                    className="shrink-0 border-amber-300 text-amber-900 hover:bg-amber-100"
                  >
                    <a
                      href={
                        outOfStockGateways.length === 1
                          ? `https://${activeShop}/admin/products/${outOfStockGateways[0].id}`
                          : `https://${activeShop}/admin/products`
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
                    shop={activeShop}
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
                    shop={activeShop}
                  />
                ))}
              </div>
            </Section>
          )}

          <BriefHistory />

          <RestockingPanel products={restocking} currency={currency} shop={activeShop} />
        </>
      )}

      <PurchaseDialog
        pack={pendingPlanPack}
        open={purchaseDialogOpen}
        onOpenChange={setPurchaseDialogOpen}
        shop={activeShop}
        currency="USD"
      />
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
