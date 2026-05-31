"use client";

import React, { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
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
  needsReauthForOrders?: boolean;
}

const SHOPIFY_PLANS = [
  {
    id: "starter",
    name: "Starter Pack",
    credits: 5,
    price: 39,
    description: "Perfect for testing new campaigns and finding winning ads.",
    highlight: false,
    features: [
      "5 Campaign Briefs",
      "Store Intelligence Insights",
      "AI-Powered Copywriter",
      "Valid for 6 months",
    ],
  },
  {
    id: "growth",
    name: "Growth Pack",
    credits: 15,
    price: 99,
    description: "For scaling brands running multiple products and tests.",
    highlight: true,
    features: [
      "15 Campaign Briefs",
      "Everything in Starter Pack",
      "Priority AI Processing",
      "Advanced Targeting Audiences",
    ],
  },
  {
    id: "scale",
    name: "Scale Pack",
    credits: 30,
    price: 179,
    description: "High volume briefs for rapid scaling and continuous optimization.",
    highlight: false,
    features: [
      "30 Campaign Briefs",
      "Everything in Growth Pack",
      "Highest Priority Generation",
      "Best Value ($5.96 / brief)",
    ],
  },
] as const;

function DashboardContent() {
  const [storeData, setStoreData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [showPaymentToast, setShowPaymentToast] = useState(false);
  const [showBillingToast, setShowBillingToast] = useState(false);
  const [shop, setShop] = useState<string | null>(null);
  const [purchaseLoading, setPurchaseLoading] = useState<string | null>(null);
  const [showRestocking, setShowRestocking] = useState(false);

  useEffect(() => {
    fetch("/api/user/credits")
      .then((r) => r.json())
      .then((data) => {
        setShop(data.shop);
      })
      .catch(() => {});
  }, []);

  const handleShopifyPurchase = async (planKey: "starter" | "growth" | "scale") => {
    if (!shop) {
      alert("Shopify domain is not connected. Please connect your store first.");
      return;
    }

    setPurchaseLoading(planKey);
    try {
      const res = await fetch("/api/shopify/billing/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          shop,
          plan: planKey,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Failed to create Shopify purchase");
      }

      const data = await res.json();

      if (data.confirmationUrl) {
        window.location.href = data.confirmationUrl;
      } else {
        alert("Failed to initialize billing. Please try again.");
        setPurchaseLoading(null);
      }
    } catch (err: any) {
      console.error("Shopify billing purchase error:", err);
      alert(err.message || "An error occurred while creating the billing charge.");
      setPurchaseLoading(null);
    }
  };

  const { credits, isUnlimited } = useCredits();

  const router = useRouter();
  const searchParams = useSearchParams();
  const paymentSuccess = searchParams.get("payment");
  const packId = searchParams.get("pack");
  const billingSuccess = searchParams.get("billing");
  const billingCredits = searchParams.get("credits");
  const billingPlan = searchParams.get("plan");

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
    if (billingSuccess === "success") {
      setShowBillingToast(true);
      setTimeout(() => {
        setShowBillingToast(false);
        window.history.replaceState({}, "", "/dashboard");
      }, 5000);
    }
  }, [billingSuccess]);

  useEffect(() => {
    fetch("/api/store/data", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: StoreDataResponse) => {
        setConnected(data.connected);
        if (data.needsReauthForOrders) {
          setNeedsReauth(true);
        }
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
      title: "You're good to go",
      subtext: "Active products, recent sales — everything Meta needs to start learning. Let's run something."
    },
    ready_with_warnings: {
      color: "bg-amber-500",
      textColor: "text-amber-400",
      icon: "!",
      title: "Ready to go",
      subtext: "Check Pre-Spend Intelligence below — we've flagged the best products to run right now."
    },
    caution: {
      color: "bg-error-500",
      textColor: "text-error-400",
      icon: "×",
      title: "Not quite yet",
      subtext: !hasRecentOrders ? "No recent orders yet. Build some organic momentum first, then come back." : "Most of your stock is out. Restock your winners and you'll be ready to go."
    },
    not_ready: {
      color: "bg-white/20",
      textColor: "text-white/60",
      icon: "?",
      title: "Store data out of sync",
      subtext: "We couldn't load your products. Click 'Sync now' or 'Reconnect' to refresh your store data."
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

  const COUNTRY_CODES: Record<string, string> = { NG: "Nigeria", GB: "United Kingdom", US: "United States", AE: "UAE", GH: "Ghana", KE: "Kenya", ZA: "South Africa", CA: "Canada", AU: "Australia", HU: "Hungary", DE: "Germany", FR: "France", IT: "Italy", ES: "Spain", NL: "Netherlands", BE: "Belgium", SE: "Sweden", NO: "Norway", DK: "Denmark", FI: "Finland", PL: "Poland", RO: "Romania", CZ: "Czech Republic", PT: "Portugal", AT: "Austria", CH: "Switzerland", IN: "India", CN: "China", JP: "Japan", KR: "South Korea", BR: "Brazil", MX: "Mexico", AR: "Argentina" };
  // Universal rule: the Shopify connector stores country as city when no city data exists.
  // Detect this by checking if city === country (or city === country code), which is always wrong data.
  const isFallbackCountryEntry = (loc: any): boolean => {
    const city = loc.city?.trim() || "";
    const country = loc.country?.trim() || "";
    if (!city) return true;
    // City matches the country name directly
    if (city.toLowerCase() === country.toLowerCase()) return true;
    // City is a 2-letter country code
    if (/^[A-Z]{2}$/.test(city)) return true;
    // City resolves to the same country name (e.g. "Hungary" city → "Hungary" country)
    const resolvedCountry = COUNTRY_CODES[country] || country;
    if (city.toLowerCase() === resolvedCountry.toLowerCase()) return true;
    return false;
  };
  const validLocations = (orders.top_locations || [])
    .filter((loc: any) => !isFallbackCountryEntry(loc))
    .slice(0, 3);
  const formatLocation = (l: any) => {
    const countryDisplay = COUNTRY_CODES[l.country] || l.country || "";
    return countryDisplay && countryDisplay.toLowerCase() !== l.city?.toLowerCase()
      ? `${l.city}, ${countryDisplay}`
      : l.city;
  };
  // If no city-level data, fall back to deduplicated country names
  const countryFallback = validLocations.length === 0
    ? [...new Set((orders.top_locations || [])
        .map((l: any) => COUNTRY_CODES[l.country] || COUNTRY_CODES[l.city] || l.country || l.city || "")
        .filter(Boolean))]
        .slice(0, 3)
        .join(" · ")
    : "";
  const locationText = validLocations.length > 0
    ? validLocations.map(formatLocation).join(" · ")
    : countryFallback || "Order location data still building";

  const refreshStoreData = () => {
    setLoading(true);
    fetch("/api/store/data?force=true", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: StoreDataResponse) => {
        setConnected(data.connected);
        if (data.needsReauthForOrders) {
          setNeedsReauth(true);
        }
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

        {/* Shopify Billing Success Toast */}
        {showBillingToast && (
          <div className="mb-6 px-4 py-3 rounded-xl bg-success-500/10 border border-success-500/20 text-sm text-success-400 flex items-center gap-2 animate-fade-in-up">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            ✓ Billing successful! Added <strong>{billingCredits} credits</strong> via Shopify for the <strong>{billingPlan} Pack</strong>.
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
        {!loading && connected && needsReauth && (
          <div className="bg-brand-500/10 border border-brand-500/20 text-brand-300 rounded-xl p-4 mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 animate-fade-in-up">
            <div>
              <h3 className="text-sm font-semibold mb-1 text-brand-300">Unlock Full Order History</h3>
              <p className="text-xs text-brand-300/70">Full order history gives you more accurate recommendations. We recently updated our permissions.</p>
            </div>
            <Link
              href="/api/auth/shopify/connect?from=dashboard"
              className="bg-brand-500/20 hover:bg-brand-500/30 border border-brand-500/20 text-brand-300 px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
            >
              Reconnect Store
            </Link>
          </div>
        )}

        {!loading && connected && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6 animate-fade-in-up">
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
              <div className="flex items-center gap-4 mt-4">
                <button onClick={refreshStoreData} className="text-white/80 hover:text-white text-sm font-medium text-left cursor-pointer bg-transparent border-none p-0">Sync now</button>
                <Link href="/api/auth/shopify/connect?from=dashboard" className="text-white/40 hover:text-white/60 text-xs font-medium transition-colors no-underline">Reconnect</Link>
              </div>
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
              {shop ? "Reconnect Your Shopify Store" : "Connect Your Shopify Store"}
            </h2>
            <p className="text-white/40 text-sm mb-6 max-w-md mx-auto">
              {shop 
                ? "Your store connection has expired. Please reconnect to continue syncing orders and generating briefs." 
                : "We'll read your store data to generate personalised campaign briefs, audience insights, and product recommendations."}
            </p>
            <Link
              href={shop ? "/api/auth/shopify/connect?from=dashboard" : "/onboarding/connect-shopify?from=dashboard"}
              className="inline-flex px-6 py-3 rounded-xl bg-brand-500 text-white text-sm font-medium transition-colors hover:bg-brand-400 no-underline"
            >
              {shop ? "Reconnect Store →" : "Connect Shopify Store →"}
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
                  {adReadinessDisplay.subtext && <p className="text-sm text-white/60">{adReadinessDisplay.subtext}</p>}
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
                    <p className="text-sm text-white mb-0.5">Average order: {formatCurrency(Math.round(aov), storeData?.store?.currency || "NGN")}</p>
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
                    <div key={i} className="rounded-xl bg-surface-raised border border-border-subtle p-5">
                      <div className="text-2xl mb-3">{insight.icon}</div>
                      <p className="text-sm font-bold text-white mb-2">{insight.title}</p>
                      <p className="text-xs text-white/60 leading-relaxed">{insight.detail}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* SECTION 3: Pre-Spend Intelligence */}
            <div className="mb-8 animate-fade-in-up-delay-2" id="advertise-now">
              <div className="mb-4">
                <p className="text-xs text-white/40 uppercase tracking-widest font-semibold mb-1">Pre-Spend Intelligence</p>
                <p className="text-sm text-white/60">Best products to advertise right now</p>
              </div>

              {/* Actionable in-stock products list */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {(storeData?.products || [])
                  .filter((p: any) => p.in_stock)
                  .sort((a: any, b: any) => b.revenue - a.revenue)
                  .slice(0, 6)
                  .map((product: any, index: number) => {
                    let subtext = "";
                    let primaryMetric = "";
                    
                    if (product.gateway_classification === "Gateway" && product.first_time_buyer_ratio) {
                      primaryMetric = `${Math.round(product.first_time_buyer_ratio * 100)}% new buyers`;
                    } else if (product.gateway_classification === "Consideration" && product.repeat_purchase_rate) {
                      primaryMetric = `${Math.round(product.repeat_purchase_rate * 100)}% repeat rate`;
                    } else if (product.order_velocity) {
                      primaryMetric = `${Math.round(product.order_velocity)} units/mo velocity`;
                    } else if (product.first_time_buyer_ratio) {
                      primaryMetric = `${Math.round(product.first_time_buyer_ratio * 100)}% new buyers`;
                    }

                    if (product.gateway_classification === "Insufficient Data") {
                      subtext = "Too early to classify — keep selling";
                    } else if (product.gateway_classification === "Gateway") {
                      subtext = "Great for cold traffic — most buyers are first-timers";
                    } else if (product.gateway_classification === "Consideration") {
                      subtext = "High consideration builder — drives high repeat purchase rates";
                    } else if (product.gateway_classification === "Hybrid") {
                      subtext = "Balanced shopper response — mixed signals across new and repeat buyers";
                    } else {
                      subtext = "Consistent behavioral performance across core acquisition metrics";
                    }

                    const isGateway = product.gateway_classification === "Gateway";
                    const isConsideration = product.gateway_classification === "Consideration";

                    return (
                      <div
                        key={product.id}
                        className="rounded-xl border p-4 bg-surface-raised border-border-subtle hover:border-brand-500/30 transition-colors"
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
                            <div className="flex items-center flex-wrap gap-2 mt-1">
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-success-500/10 text-success-400">
                                <span className="w-1 h-1 rounded-full bg-success-400" />
                                In stock
                              </span>
                              
                              {product.gateway_classification && (
                                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                                  isGateway
                                    ? "bg-brand-500/10 text-brand-400 border-brand-500/20"
                                    : isConsideration
                                    ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                                    : product.gateway_classification === "Insufficient Data"
                                    ? "bg-white/5 text-white/40 border-white/10"
                                    : "bg-purple-500/10 text-purple-400 border-purple-500/20"
                                }`}>
                                  {product.gateway_classification === "Insufficient Data"
                                    ? "Needs more sales data"
                                    : product.gateway_classification}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {(subtext || primaryMetric) && (
                          <div className="mb-3 px-2 py-1.5 bg-white/5 rounded-md">
                            {subtext && <p className="text-[11px] text-white/70 italic">{subtext}</p>}
                            {primaryMetric && <p className="text-[11px] text-white mt-1 font-medium">{primaryMetric}</p>}
                          </div>
                        )}

                        <div className="flex items-center justify-between text-xs">
                          <span className="text-white/40">
                            {product.units_sold} sold · {formatCurrency(Math.round(product.revenue), storeData?.store?.currency || "USD")}
                          </span>
                          {product.should_advertise ? (
                            <button
                              onClick={() => {
                                sessionStorage.setItem("campaign_draft", JSON.stringify({
                                  product_name: product.name,
                                  product_description: product.description || product.name,
                                  product_type: product.product_type || "",
                                  product_tags: product.tags?.join(",") || "",
                                  product_price: product.price,
                                  product_image: product.image_url || ""
                                }));
                                router.push("/campaigns");
                              }}
                              className="text-brand-400 hover:text-brand-300 font-medium transition-colors cursor-pointer bg-transparent border-none p-0"
                            >
                              Create a Campaign Brief →
                            </button>
                          ) : (
                            <span className="text-white/30 text-[10px]">Low conversion probability</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>

              {/* Collapsed Restocking Opportunities Section */}
              {(() => {
                const restockingProducts = (storeData?.products || [])
                  .filter((p: any) => !p.in_stock && p.units_sold > 0)
                  .sort((a: any, b: any) => b.revenue - a.revenue);

                if (restockingProducts.length === 0) return null;

                return (
                  <div className="mt-6 border border-border-subtle bg-surface/30 rounded-xl overflow-hidden">
                    <button
                      onClick={() => setShowRestocking(!showRestocking)}
                      className="w-full flex items-center justify-between px-5 py-4 text-left transition-colors hover:bg-white/[0.02] cursor-pointer border-none bg-transparent"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-semibold text-white/75">Restocking Opportunities</h3>
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-400">
                            {restockingProducts.length} items
                          </span>
                        </div>
                        <p className="text-xs text-white/40 mt-1">Restock these before running ads</p>
                      </div>
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`text-white/40 transition-transform duration-200 ${showRestocking ? "rotate-180" : ""}`}
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>

                    {showRestocking && (
                      <div className="px-5 pb-5 border-t border-border-subtle/50 pt-4 animate-fade-in">
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                          {restockingProducts.map((product: any) => {
                            const isGateway = product.gateway_classification === "Gateway";
                            const isConsideration = product.gateway_classification === "Consideration";
                            return (
                              <div
                                key={product.id}
                                className="rounded-xl border p-4 bg-surface-raised/50 border-border-subtle/50 opacity-75 grayscale hover:grayscale-0 hover:opacity-100 transition-all duration-300"
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
                                    <div className="flex items-center flex-wrap gap-2 mt-1">
                                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-error-500/10 text-error-400">
                                        <span className="w-1 h-1 rounded-full bg-error-400" />
                                        Out of stock
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
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-white/40">
                                    {product.units_sold} sold · {formatCurrency(Math.round(product.revenue), storeData?.store?.currency || "USD")}
                                  </span>
                                  <span className="text-amber-400/80 text-[10px] font-medium">Restock opportunity</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* Shopify Billing Credit Purchase Section */}
            {!loading && connected && (
              <div className="mb-8 animate-fade-in-up bg-surface-raised/30 border border-border-subtle/50 rounded-2xl p-6 sm:p-8 mt-12">
                <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <p className="text-xs text-brand-400 uppercase tracking-widest font-mono font-bold mb-1">Acquire Credits</p>
                    <h2 className="text-xl font-bold text-white tracking-tight">Campaign Brief Credit Packs</h2>
                    <p className="text-xs text-white/50 mt-1">Direct integration with Shopify Billing API. Purchase one-time packs to instantly generate ad briefs.</p>
                  </div>
                  {credits !== null && (
                    <div className="inline-flex items-center gap-2 rounded-full border border-[#a855f7]/30 bg-[#a855f7]/10 px-4 py-1.5 text-xs text-[#d8b4fe] font-medium backdrop-blur-sm shrink-0 self-start sm:self-center">
                      <span className="w-2 h-2 rounded-full bg-[#a855f7] animate-pulse"></span>
                      Current Balance: <strong className="font-semibold text-white ml-0.5">{credits} briefs remaining</strong>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-4xl">
                  {SHOPIFY_PLANS.map((pack) => (
                    <div
                      key={pack.id}
                      className={`flex flex-col rounded-xl p-5 transition-all duration-300 hover:scale-[1.02] border
                        ${pack.highlight ? "border-[#a855f7] bg-[#a855f7]/5 shadow-[0_4px_20px_-5px_rgba(168,85,247,0.15)]" : "border-border-subtle bg-white/[0.01]"}
                      `}
                    >
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <h3 className="text-sm font-bold text-white">{pack.name}</h3>
                          <span className="inline-block text-[10px] font-mono text-[#d8b4fe]/90 mt-0.5 font-semibold">
                            {pack.credits} Credits
                          </span>
                        </div>
                        {pack.highlight && (
                          <span className="rounded bg-[#a855f7]/20 border border-[#a855f7]/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[#d8b4fe]">
                            Best Choice
                          </span>
                        )}
                      </div>

                      <div className="flex items-baseline gap-1 mb-3">
                        <span className="font-serif font-black text-2xl text-[#a855f7]">${pack.price}</span>
                        <span className="font-mono text-[9px] text-white/40">USD</span>
                      </div>

                      <p className="text-[11px] leading-relaxed text-white/50 mb-5 min-h-[32px]">
                        {pack.description}
                      </p>

                      <ul className="space-y-2 mb-6 flex-1 border-t border-white/5 pt-4">
                        {pack.features.map((f) => (
                          <li key={f} className="flex items-center gap-1.5 text-[11px] text-white/60">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-[#a855f7] flex-shrink-0">
                              <polyline points="20 6 9 17 4 12"/>
                            </svg>
                            {f}
                          </li>
                        ))}
                      </ul>

                      <button
                        onClick={() => handleShopifyPurchase(pack.id as "starter" | "growth" | "scale")}
                        disabled={purchaseLoading !== null}
                        className={`w-full py-2 rounded-lg font-medium text-xs transition-colors disabled:opacity-50 cursor-pointer
                          ${pack.highlight
                            ? "bg-[#a855f7] hover:bg-[#9333ea] text-white"
                            : "border border-white/15 text-white hover:bg-white/5"
                          }`}
                      >
                        {purchaseLoading === pack.id ? "Redirecting..." : "Buy Credits"}
                      </button>
                    </div>
                  ))}
                </div>
                
                <div className="mt-4 text-center text-[10px] text-white/30">
                  Secured and verified via Shopify Billing API. Credits never expire within 6 months of purchase.
                </div>
              </div>
            )}
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
