"use client";

import React, { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { SignOutButton } from "@clerk/nextjs";
import { formatCurrency } from "@/lib/currency";

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
  const [credits, setCredits] = useState(0);
  const [isUnlimited, setIsUnlimited] = useState(false);
  const [unlimitedUntil, setUnlimitedUntil] = useState<string | null>(null);

  const searchParams = useSearchParams();
  const paymentSuccess = searchParams.get("payment");
  const packId = searchParams.get("pack");

  useEffect(() => {
    fetch("/api/store/data", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: StoreDataResponse) => {
        setConnected(data.connected);
        if (data.connected && data.data) {
          setStoreData(data.data);
        }
        setCredits(data.credits_balance || 0);
        
        if (data.credits_unlimited_until) {
          const unlimitedDate = new Date(data.credits_unlimited_until);
          if (unlimitedDate > new Date()) {
            setIsUnlimited(true);
            setUnlimitedUntil(data.credits_unlimited_until);
          }
        }
        
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Compute health scores client-side from store data
  const computeHealth = () => {
    if (!storeData) return { score: 0, breakdown: [] };

    const products = storeData.products || [];
    const orders30 = storeData.orders?.orders_last_30_days || 0;
    const repeatRate = storeData.orders?.repeat_customer_rate || 0;
    const inStockPct = products.length > 0
      ? products.filter((p: any) => p.in_stock).length / products.length
      : 0;

    const b = [
      {
        label: "Active Products",
        score: products.length >= 10 ? 25 : products.length >= 5 ? 15 : products.length >= 1 ? 5 : 0,
        max: 25,
        status: products.length >= 10 ? "good" : products.length >= 5 ? "warning" : "bad",
      },
      {
        label: "Recent Orders",
        score: orders30 >= 20 ? 25 : orders30 >= 5 ? 15 : orders30 >= 1 ? 5 : 0,
        max: 25,
        status: orders30 >= 20 ? "good" : orders30 >= 5 ? "warning" : "bad",
      },
      {
        label: "Customer Retention",
        score: repeatRate > 0.3 ? 25 : repeatRate > 0.1 ? 15 : repeatRate > 0.01 ? 5 : 0,
        max: 25,
        status: repeatRate > 0.3 ? "good" : repeatRate > 0.1 ? "warning" : "bad",
      },
      {
        label: "Product Availability",
        score: inStockPct > 0.8 ? 25 : inStockPct > 0.5 ? 15 : inStockPct > 0.2 ? 5 : 0,
        max: 25,
        status: inStockPct > 0.8 ? "good" : inStockPct > 0.5 ? "warning" : "bad",
      },
    ];

    const breakdownWithPercentage = b.map(item => ({
      ...item,
      percentage: Math.round((item.score / item.max) * 100)
    }));

    return {
      score: b.reduce((s, i) => s + i.score, 0),
      breakdown: breakdownWithPercentage,
    };
  };

  const health = computeHealth();

  const statusColor = (s: string) =>
    s === "good" ? "bg-success-400" : s === "warning" ? "bg-amber-400" : "bg-error-400";

  const statusText = (s: string) =>
    s === "good" ? "text-success-400" : s === "warning" ? "text-amber-400" : "text-error-400";

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      {/* Nav */}
      <nav className="border-b border-border-subtle bg-surface/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center shadow-lg shadow-brand-500/20">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
              </svg>
            </div>
            <span className="text-sm font-semibold tracking-tight text-white/90">omni-target</span>
          </div>
          <div className="hidden sm:flex items-center justify-center gap-6 absolute left-1/2 -translate-x-1/2">
            <Link href="/dashboard" className="text-sm font-medium text-white/90 transition-colors">Dashboard</Link>
            <Link href="/campaigns" className="text-sm font-medium text-white/60 hover:text-white/90 transition-colors">Campaigns</Link>
            
            {(credits > 0 || isUnlimited) && (
              <span className="text-xs text-white/50">
                {isUnlimited ? "Unlimited" : `${credits} briefs`}
              </span>
            )}
            
            {credits === 0 && !isUnlimited && (
              <Link href="/pricing" className="text-sm font-medium text-brand-400 hover:text-brand-300 transition-colors">Buy Credits</Link>
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
        {paymentSuccess === "success" && (
          <div className="mb-6 px-4 py-3 rounded-xl bg-success-500/10 border border-success-500/20 text-sm text-success-400 flex items-center gap-2 animate-fade-in-up">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Payment successful! Your credits have been added. Let&apos;s create your first brief.
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
            {/* SECTION 1: Store Health Score */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8 animate-fade-in-up">
              <div className="rounded-xl bg-surface-raised border border-border-subtle p-6 flex flex-col items-center justify-center text-center">
                <p className="text-xs text-white/40 uppercase tracking-widest mb-3 font-semibold">Store Health</p>
                <p className={`text-5xl font-black mb-1 ${health.score >= 75 ? "text-success-400" : health.score >= 50 ? "text-amber-400" : "text-error-400"}`}>
                  {health.score}
                </p>
                <p className="text-sm text-white/30">out of 100</p>
              </div>

              <div className="lg:col-span-2 rounded-xl bg-surface-raised border border-border-subtle p-6">
                <p className="text-xs text-white/40 uppercase tracking-widest mb-4 font-semibold">Breakdown</p>
                <div className="space-y-3">
                  {health.breakdown.map((item: any) => (
                    <div key={item.label} className="flex items-center gap-3">
                      <span className="text-xs text-white/60 w-36 shrink-0">{item.label}</span>
                      <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-700 ${statusColor(item.status)}`}
                          style={{ width: `${(item.score / item.max) * 100}%` }}
                        />
                      </div>
                      <span className={`text-xs font-semibold w-10 text-right ${statusText(item.status)}`}>
                        {item.percentage}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* SECTION 2: Audience Intelligence */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
              <div className="rounded-xl bg-surface-raised border border-border-subtle p-6 animate-fade-in-up-delay-1">
                <p className="text-xs text-white/40 uppercase tracking-widest mb-4 font-semibold">Top Buying Locations</p>
                {storeData.orders?.top_locations?.length > 0 ? (
                  <div className="space-y-3">
                    {storeData.orders.top_locations.map((loc: any, i: number) => (
                      <div key={i} className="flex items-center gap-3">
                        <span className="text-xs text-white/70 w-28 truncate shrink-0">{loc.city}</span>
                        <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                          <div className="h-full bg-brand-400 rounded-full transition-all duration-700" style={{ width: `${loc.percentage}%` }} />
                        </div>
                        <span className="text-xs text-white/50 w-10 text-right">{loc.percentage}%</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-white/30 italic">No order data yet</p>
                )}
              </div>

              <div className="rounded-xl bg-surface-raised border border-border-subtle p-6 animate-fade-in-up-delay-1">
                <p className="text-xs text-white/40 uppercase tracking-widest mb-4 font-semibold">Key Metrics</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-2xl font-bold text-white">
                      {formatCurrency(Math.round(storeData.orders?.average_order_value || 0), storeData.store?.currency || "USD")}
                    </p>
                    <p className="text-xs text-white/40 mt-1">Avg Order Value</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-white">
                      {Math.round((storeData.orders?.repeat_customer_rate || 0) * 100)}%
                    </p>
                    <p className="text-xs text-white/40 mt-1">Repeat Rate</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-white">
                      {storeData.orders?.orders_last_30_days || 0}
                    </p>
                    <p className="text-xs text-white/40 mt-1">Orders (30d)</p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white/70 mt-1">
                      {storeData.orders?.peak_days?.length > 0
                        ? storeData.orders.peak_days.join(", ")
                        : "—"}
                    </p>
                    <p className="text-xs text-white/40 mt-1">Peak Days</p>
                  </div>
                </div>
              </div>
            </div>

            {/* SECTION 3: What to Advertise Now */}
            <div className="mb-8 animate-fade-in-up-delay-2">
              <p className="text-xs text-white/40 uppercase tracking-widest mb-4 font-semibold">What to Advertise Now</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {(storeData.products || [])
                  .sort((a: any, b: any) => b.revenue - a.revenue)
                  .slice(0, 6)
                  .map((product: any) => (
                    <div
                      key={product.id}
                      className={`rounded-xl border p-4 transition-colors ${
                        product.should_advertise
                          ? "bg-surface-raised border-border-subtle hover:border-brand-500/30"
                          : "bg-surface-raised/50 border-border-subtle opacity-60"
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
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center justify-between text-xs">
                        <span className="text-white/40">
                          {product.units_sold} sold · {formatCurrency(Math.round(product.revenue), storeData.store?.currency || "USD")}
                        </span>
                        {product.should_advertise ? (
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
                            Use in Campaign →
                          </Link>
                        ) : (
                          <span className="text-error-400/70 text-[10px]">Don&apos;t advertise</span>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            </div>

            {/* SECTION 4: Quick Actions */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 animate-fade-in-up-delay-3">
              <Link
                href="/campaigns"
                className="rounded-xl bg-surface-raised border border-border-subtle p-5 hover:border-brand-500/30 transition-colors group no-underline"
              >
                <div className="w-10 h-10 rounded-xl bg-brand-500/10 flex items-center justify-center mb-3 group-hover:bg-brand-500/20 transition-colors">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-400">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-white">Create New Brief</p>
                <p className="text-xs text-white/40 mt-1">Generate a campaign brief with AI</p>
              </Link>

              <Link
                href="/onboarding/audit?from=dashboard"
                className="rounded-xl bg-surface-raised border border-border-subtle p-5 hover:border-brand-500/30 transition-colors group no-underline"
              >
                <div className="w-10 h-10 rounded-xl bg-[#8b5cf6]/10 flex items-center justify-center mb-3 group-hover:bg-[#8b5cf6]/20 transition-colors">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[#8b5cf6]">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-white">Run Store Audit</p>
                <p className="text-xs text-white/40 mt-1">Check your store readiness</p>
              </Link>

              <Link
                href="/settings"
                className="rounded-xl bg-surface-raised border border-border-subtle p-5 hover:border-brand-500/30 transition-colors group no-underline"
              >
                <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center mb-3 group-hover:bg-white/10 transition-colors">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/50">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-white">Settings</p>
                <p className="text-xs text-white/40 mt-1">Manage integrations</p>
              </Link>
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
