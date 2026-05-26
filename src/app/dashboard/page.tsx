"use client";

import React, { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { SignOutButton } from "@clerk/nextjs";
import { Logo } from "@/components/Logo";
import { formatCurrency } from "@/lib/currency";
import { useCredits } from "@/hooks/useCredits";

interface StoreDataResponse {
  connected: boolean;
  data?: any;
  message?: string;
  credits_balance?: number;
  credits_unlimited_until?: string | null;
}

function DashboardContent() {
  const [storeData, setStoreData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [showPaymentToast, setShowPaymentToast] = useState(false);

  const { credits, isUnlimited } = useCredits();

  const searchParams = useSearchParams();
  const paymentSuccess = searchParams.get("payment");
  const packId = searchParams.get("pack");

  useEffect(() => {
    if (paymentSuccess === "success") {
      setShowPaymentToast(true);
      setTimeout(() => {
        setShowPaymentToast(false);
        window.history.replaceState({}, "", "/dashboard");
      }, 4000);
    }
  }, [paymentSuccess]);

  useEffect(() => {
    fetch("/api/store/data", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: StoreDataResponse) => {
        setConnected(data.connected);
        if (data.connected && data.data) {
          setStoreData(data.data);
        }
        
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Analytics computation
  const products = storeData?.products || [];
  const orders = storeData?.orders || { orders_last_30_days: 0, average_order_value: 0, repeat_customer_rate: 0, top_locations: [], peak_days: [] };
  
  // Ad Readiness
  const outOfStockRatio = products.length > 0
    ? products.filter((p: any) => !p.in_stock).length / products.length
    : 1;
  const hasRecentOrders = orders.orders_last_30_days > 0;
  const hasProducts = products.length > 0;

  const adReadiness = 
    !hasProducts ? "not_ready"
    : outOfStockRatio > 0.8 ? "caution"
    : !hasRecentOrders ? "caution"
    : outOfStockRatio > 0.5 ? "ready_with_warnings"
    : "ready";

  const adReadinessDisplay = {
    ready: {
      color: "bg-success-500",
      textColor: "text-success-400",
      icon: "✓",
      title: "Ready to advertise",
      subtext: "Your store has active products and recent sales. Good time to run campaigns."
    },
    ready_with_warnings: {
      color: "bg-amber-500",
      textColor: "text-amber-400",
      icon: "!",
      title: "Ready — with caveats",
      subtext: "Some products are out of stock. Stick to in-stock items when creating briefs."
    },
    caution: {
      color: "bg-error-500",
      textColor: "text-error-400",
      icon: "×",
      title: "Not ready to advertise",
      subtext: !hasRecentOrders ? "No recent orders. Drive organic traffic first." : "High out of stock rate. Restock before advertising."
    },
    not_ready: {
      color: "bg-white/20",
      textColor: "text-white/60",
      icon: "?",
      title: "Connect your store first",
      subtext: "We need data to assess readiness."
    }
  }[adReadiness];

  // Insights
  const insights = [];
  const aov = orders.average_order_value || 0;
  const repeatRate = orders.repeat_customer_rate || 0;
  const peakDays = orders.peak_days || [];
  const orders30d = orders.orders_last_30_days || 0;

  if (aov > 100000) {
    insights.push({
      icon: "💡",
      title: "Premium positioning works",
      detail: `Your average order of ₦${Math.round(aov/1000)}k means buyers trust your pricing. Target 'Luxury goods' and 'Fashion enthusiasts' in Meta.`
    });
  }
  
  if (repeatRate > 0.2) {
    insights.push({
      icon: "🔄",
      title: "Build a lookalike audience",
      detail: `${Math.round(repeatRate*100)}% of your buyers return. Upload your customer list to Meta and create a lookalike — these are your best potential new customers.`
    });
  }
  
  if (outOfStockRatio > 0.5) {
    insights.push({
      icon: "⚠️",
      title: "Stock up before running ads",
      detail: `${Math.round(outOfStockRatio * 100)}% of your products are out of stock. Running ads to unavailable products wastes budget and frustrates buyers.`,
      action: "See in-stock products",
      actionHref: "/products"
    });
  }
  
  if (peakDays.includes("Saturday") || peakDays.includes("Sunday")) {
    insights.push({
      icon: "📅",
      title: "Time your campaigns right",
      detail: `Your buyers are most active on ${peakDays.slice(0,2).join(" and ")}. Launch your Meta campaigns on Thursday evening to build momentum before the weekend.`
    });
  }
  
  if (orders30d >= 10 && orders30d < 30) {
    insights.push({
      icon: "📈",
      title: "Ready to scale",
      detail: `${orders30d} orders last month without paid ads shows organic demand. A targeted Meta campaign could multiply this significantly.`
    });
  }

  const validLocations = (orders.top_locations || []).filter((loc: any) => {
    const isNigeria = loc.country === 'Nigeria' || loc.country === 'NG' || !loc.country; 
    return isNigeria || loc.percentage >= 15;
  });
  const locationText = validLocations.length > 0 
    ? validLocations.map((l: any) => l.city).join(", ")
    : "Order location data still building";

  const refreshStoreData = () => {
    setLoading(true);
    fetch("/api/store/data?force=true", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: StoreDataResponse) => {
        setConnected(data.connected);
        if (data.connected && data.data) {
          setStoreData(data.data);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      {/* Nav */}
      <nav className="border-b border-border-subtle bg-surface/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 flex items-center justify-center">
              <Logo className="w-8 h-8 text-[#9333ea]" />
            </div>
            <span className="text-sm font-semibold tracking-tight text-white/90">Omni Target</span>
          </div>
          <div className="hidden sm:flex items-center justify-center gap-6 absolute left-1/2 -translate-x-1/2">
            <Link href="/dashboard" className="text-sm font-medium text-white/90 transition-colors">Dashboard</Link>
            <Link href="/campaigns" className="text-sm font-medium text-white/60 hover:text-white/90 transition-colors">Campaigns</Link>
            
            {isUnlimited ? (
              <span className="text-xs text-brand-400 font-medium">
                Unlimited
              </span>
            ) : credits !== null && (
              <span className="text-xs font-medium text-white/50">
                {credits} briefs left
              </span>
            )}
            
            <Link href="/settings" className="text-sm font-medium text-white/60 hover:text-white/90 transition-colors">Settings</Link>
          </div>
          <div className="flex items-center gap-6">
            <SignOutButton>
              <button className="text-xs font-medium text-white/40 hover:text-white/80 transition-colors cursor-pointer bg-transparent border-none p-0">
                Sign Out
              </button>
            </SignOutButton>
            <Link
              href="/campaigns"
              className="hidden sm:inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-500/10 border border-brand-500/20 text-xs font-medium text-brand-400 hover:bg-brand-500/20 transition-colors no-underline"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New Brief
            </Link>
          </div>
        </div>
      </nav>

      {/* Background */}
      <div className="fixed top-0 left-1/4 w-[500px] h-[500px] bg-brand-600/5 rounded-full blur-[120px] pointer-events-none" />
      <div className="fixed bottom-0 right-1/3 w-[400px] h-[400px] bg-success-500/3 rounded-full blur-[100px] pointer-events-none" />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 relative">
        {/* Success Toast */}
        {showPaymentToast && (
          <div className="mb-6 px-4 py-3 rounded-xl bg-success-500/10 border border-success-500/20 text-sm text-success-400 flex items-center gap-2 animate-fade-in-up">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            ✓ Payment successful! Your briefs have been added. Let&apos;s create your first campaign brief.
          </div>
        )}

        {/* Header */}
        <div className="mb-8 animate-fade-in-up">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-1">
            Store Intelligence
          </h1>
          <p className="text-sm text-white/40">
            {storeData
              ? `${storeData.store?.name || "Your Store"} · Last synced ${new Date(storeData.generated_at).toLocaleString()}`
              : "Connect your Shopify store to unlock insights"}
          </p>
        </div>

        {/* Quick Actions */}
        {!loading && connected && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8 animate-fade-in-up">
            <Link
              href="/campaigns"
              className="rounded-xl bg-brand-500/10 border border-brand-500/20 p-5 flex flex-col justify-between hover:bg-brand-500/20 transition-colors no-underline group"
            >
              <div>
                <p className="text-sm font-semibold text-white mb-1">Create a Campaign Brief</p>
                <p className="text-xs text-white/60">Turn a product into a ready-to-use Meta ad brief in 2 minutes</p>
              </div>
              <span className="text-brand-400 group-hover:text-brand-300 text-sm font-medium mt-4 inline-block transition-colors">Create a Campaign Brief →</span>
            </Link>
            
            <div className="rounded-xl bg-surface-raised border border-border-subtle p-5 flex flex-col justify-between">
              <div>
                <p className="text-sm font-semibold text-white mb-1">Sync Store Data</p>
                <p className="text-xs text-white/60">
                  Last synced {storeData?.generated_at ? (() => {
                    const diff = Date.now() - new Date(storeData.generated_at).getTime();
                    const minutes = Math.floor(diff / 60000);
                    if (minutes < 60) return `${minutes}m ago`;
                    const hours = Math.floor(minutes / 60);
                    if (hours < 24) return `${hours}h ago`;
                    return `${Math.floor(hours / 24)}d ago`;
                  })() : 'Unknown'}
                </p>
              </div>
              <button onClick={refreshStoreData} className="text-white/80 hover:text-white text-sm font-medium mt-4 text-left cursor-pointer bg-transparent border-none p-0">Sync now</button>
            </div>

            <div className="rounded-xl bg-surface-raised border border-border-subtle p-5 flex flex-col justify-between">
              <div>
                <p className="text-sm font-semibold text-white mb-1">Buy Briefs</p>
                <p className="text-xs text-white/60">
                  {credits === 0 ? "You have no briefs remaining" : `${credits} briefs remaining`}
                </p>
              </div>
              <Link href="/pricing" className="text-white/80 hover:text-white text-sm font-medium mt-4 inline-block no-underline">
                {credits === 0 ? "Buy credits →" : "Buy more →"}
              </Link>
            </div>
          </div>
        )}

        {/* Loading State */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="rounded-xl bg-surface-raised border border-border-subtle p-5 h-32 animate-pulse flex flex-col justify-between">
                <div className="w-10 h-10 rounded-xl bg-white/5" />
                <div className="space-y-2">
                  <div className="h-6 w-24 bg-white/5 rounded" />
                  <div className="h-4 w-32 bg-white/5 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : !connected ? (
          /* Not Connected State */
          <div className="text-center py-20 rounded-xl bg-surface-raised border border-border-subtle mb-8 animate-fade-in-up">
            <div className="w-16 h-16 rounded-full bg-brand-500/10 flex items-center justify-center mx-auto mb-4">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-brand-400">
                <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
                <line x1="3" y1="6" x2="21" y2="6" />
                <path d="M16 10a4 4 0 0 1-8 0" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-white mb-3">
              Connect Your Shopify Store
            </h2>
            <p className="text-white/40 text-sm mb-6 max-w-md mx-auto">
              We&apos;ll read your store data to generate personalised campaign briefs, audience insights, and product recommendations.
            </p>
            <Link
              href="/onboarding/connect-shopify"
              className="inline-flex px-6 py-3 rounded-xl bg-brand-500 text-white text-sm font-medium transition-colors hover:bg-brand-400 no-underline"
            >
              Connect Shopify Store →
            </Link>
          </div>
        ) : (
          <>
            {/* SECTION 1: Ad Readiness & Audience */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8 animate-fade-in-up">
              <div className="rounded-xl bg-surface-raised border border-border-subtle p-6 flex items-start gap-4">
                <div className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 ${adReadinessDisplay.color} text-white font-bold text-xl`}>
                  {adReadinessDisplay.icon}
                </div>
                <div>
                  <p className="text-xs text-white/40 uppercase tracking-widest mb-1 font-semibold">Ad Readiness</p>
                  <p className={`text-lg font-bold mb-1 ${adReadinessDisplay.textColor}`}>{adReadinessDisplay.title}</p>
                  <p className="text-sm text-white/60">{adReadinessDisplay.subtext}</p>
                </div>
              </div>

              <div className="rounded-xl bg-surface-raised border border-border-subtle p-6">
                <p className="text-xs text-white/40 uppercase tracking-widest mb-4 font-semibold">Your Buyers</p>
                <div className="space-y-4">
                  <div>
                    <p className="text-xs text-white/50 uppercase font-semibold mb-1">Where they buy from:</p>
                    <p className="text-sm text-white">{locationText}</p>
                  </div>
                  <div>
                    <p className="text-xs text-white/50 uppercase font-semibold mb-1">When they buy:</p>
                    <p className="text-sm text-white mb-0.5">Peak days: {peakDays.length > 0 ? peakDays.join(", ") : "—"}</p>
                    {peakDays.length > 0 && (
                      <p className="text-xs text-white/50">→ Launch campaigns on {peakDays[0] === 'Saturday' || peakDays[0] === 'Sunday' ? 'Friday evening' : 'the day before'} to catch your {peakDays[0]} buyers</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-white/50 uppercase font-semibold mb-1">How much they spend:</p>
                    <p className="text-sm text-white mb-0.5">Average order: {formatCurrency(Math.round(aov), storeData.store?.currency || "NGN")}</p>
                    <p className="text-xs text-white/50">
                      {aov > 100000 ? "Premium buyers — target higher income audiences" :
                       aov >= 30000 ? "Mid-market buyers — broad targeting works well" :
                       "Value-conscious buyers — focus on deals and new arrivals"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-white/50 uppercase font-semibold mb-1">Loyalty:</p>
                    <p className="text-sm text-white mb-0.5">{Math.round(repeatRate * 100)}% buy again</p>
                    <p className="text-xs text-white/50">
                      {repeatRate < 0.15 ? "Most buyers are new. Focus ads on acquisition." :
                       repeatRate <= 0.30 ? "Healthy loyalty. Test retargeting campaigns." :
                       "Strong loyalty. Create lookalike audiences from your best customers."}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* SECTION 2: Insights */}
            {insights.length > 0 && (
              <div className="mb-8 animate-fade-in-up-delay-1">
                <p className="text-xs text-white/40 uppercase tracking-widest mb-4 font-semibold">What this means for your ads</p>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {insights.map((insight, i) => (
                    <div key={i} className="rounded-xl bg-surface-raised border border-border-subtle p-5 flex flex-col justify-between">
                      <div>
                        <div className="text-2xl mb-3">{insight.icon}</div>
                        <p className="text-sm font-bold text-white mb-2">{insight.title}</p>
                        <p className="text-xs text-white/60 mb-4 leading-relaxed">{insight.detail}</p>
                      </div>
                      {insight.action && insight.actionHref && (
                        <Link href={insight.actionHref} className="text-xs font-medium text-brand-400 hover:text-brand-300 no-underline inline-block">
                          {insight.action} →
                        </Link>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* SECTION 3: Pre-Spend Intelligence */}
            <div className="mb-8 animate-fade-in-up-delay-2" id="advertise-now">
              <div className="mb-4">
                <p className="text-xs text-white/40 uppercase tracking-widest font-semibold mb-1">Pre-Spend Intelligence</p>
                <p className="text-sm text-white/60">High-signal products mapped by behavioral velocity and acquisition potential.</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {(storeData.products || [])
                  .sort((a: any, b: any) => b.revenue - a.revenue)
                  .slice(0, 6)
                  .map((product: any, index: number) => {
                    let subtext = "";
                    if (!product.in_stock) {
                      subtext = "Out of stock — restock before advertising";
                    } else {
                      const signals = [];
                      if (product.first_time_buyer_ratio) {
                        signals.push(`${Math.round(product.first_time_buyer_ratio * 100)}% new buyers`);
                      }
                      if (product.repeat_purchase_rate) {
                        signals.push(`${Math.round(product.repeat_purchase_rate * 100)}% repeat rate`);
                      }
                      if (product.order_velocity) {
                        signals.push(`${Math.round(product.order_velocity)} units/mo velocity`);
                      }
                      subtext = signals.length > 0 ? signals.join(" · ") : "Consistent behavioral performance";
                    }

                    const isGateway = product.gateway_classification === "Gateway";
                    const isConsideration = product.gateway_classification === "Consideration";

                    return (
                      <div
                        key={product.id}
                        className={`rounded-xl border p-4 transition-colors ${
                          product.in_stock && product.should_advertise
                            ? "bg-surface-raised border-border-subtle hover:border-brand-500/30"
                            : "bg-surface-raised/30 border-border-subtle/50 opacity-60 grayscale"
                        }`}
                      >
                        <div className="flex items-start gap-3 mb-3">
                          {product.image_url ? (
                            <img
                              src={product.image_url}
                              alt={product.name}
                              className="w-12 h-12 rounded-lg object-cover shrink-0"
                            />
                          ) : (
                            <div className="w-12 h-12 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/20">
                                <rect x="3" y="3" width="18" height="18" rx="2" />
                                <circle cx="8.5" cy="8.5" r="1.5" />
                                <polyline points="21 15 16 10 5 21" />
                              </svg>
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-white truncate">{product.name}</p>
                            <div className="flex items-center gap-2 mt-1">
                              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                product.in_stock
                                  ? "bg-success-500/10 text-success-400"
                                  : "bg-error-500/10 text-error-400"
                              }`}>
                                <span className={`w-1 h-1 rounded-full ${product.in_stock ? "bg-success-400" : "bg-error-400"}`} />
                                {product.in_stock ? "In stock" : "Out of stock"}
                              </span>
                              
                              {product.gateway_classification && (
                                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                                  isGateway
                                    ? "bg-brand-500/10 text-brand-400 border-brand-500/20"
                                    : isConsideration
                                    ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                                    : "bg-purple-500/10 text-purple-400 border-purple-500/20"
                                }`}>
                                  {product.gateway_classification}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {subtext && (
                          <div className="mb-3 px-2 py-1.5 bg-white/5 rounded-md">
                            <p className="text-[11px] text-white/70 italic">{subtext}</p>
                          </div>
                        )}

                        <div className="flex items-center justify-between text-xs">
                          <span className="text-white/40">
                            {product.units_sold} sold · {formatCurrency(Math.round(product.revenue), storeData.store?.currency || "USD")}
                          </span>
                          {product.in_stock && product.should_advertise ? (
                            <Link
                              href={`/campaigns?` +
                                `product_name=${encodeURIComponent(product.name)}&` +
                                `product_description=${encodeURIComponent(product.description || product.name)}&` +
                                `product_type=${encodeURIComponent(product.product_type || "")}&` +
                                `product_tags=${encodeURIComponent(product.tags?.join(",") || "")}&` +
                                `product_price=${product.price}&` +
                                `product_image=${encodeURIComponent(product.image_url || "")}`
                              }
                              className="text-brand-400 hover:text-brand-300 font-medium transition-colors no-underline"
                            >
                              Create a Campaign Brief →
                            </Link>
                          ) : !product.in_stock ? (
                            <span className="text-error-400/70 text-[10px]">Cannot advertise</span>
                          ) : (
                            <span className="text-white/30 text-[10px]">Low conversion probability</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[var(--background)] flex items-center justify-center text-white/50">Loading...</div>}>
      <DashboardContent />
    </Suspense>
  );
}
