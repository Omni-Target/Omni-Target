"use client";

import React, { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { CREDIT_PACKS } from "@/lib/credit-packs";
import Link from "next/link";
import { formatCurrency } from "@/lib/currency";

interface StoreDataResponse {
  connected: boolean;
  data?: any;
  message?: string;
  credits_balance?: number;
  credits_unlimited_until?: string | null;
}

export default function PricingPage() {
  const { user } = useUser();
  const [currency, setCurrency] = useState<"NGN" | "USD">("USD");
  const [credits, setCredits] = useState(0);
  const [isUnlimited, setIsUnlimited] = useState(false);
  const [unlimitedUntil, setUnlimitedUntil] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activePackId, setActivePackId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/store/data", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: StoreDataResponse) => {
        if (data.connected && data.data?.store?.currency === "NGN") {
          setCurrency("NGN");
        } else {
          setCurrency("USD");
        }
        
        setCredits(data.credits_balance || 0);
        
        if (data.credits_unlimited_until) {
          const unlimitedDate = new Date(data.credits_unlimited_until);
          if (unlimitedDate > new Date()) {
            setIsUnlimited(true);
            setUnlimitedUntil(data.credits_unlimited_until);
          }
        }
      })
      .catch((err) => console.error(err));
  }, []);

  const handleCheckout = async (packId: string) => {
    setLoading(true);
    setActivePackId(packId);

    try {
      if (currency === "NGN") {
        const res = await fetch("/api/payments/paystack/initiate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            packId,
            email: user?.emailAddresses[0]?.emailAddress,
          }),
        });
        const data = await res.json();
        if (data.authorization_url) {
          window.location.href = data.authorization_url;
        } else {
          alert("Failed to initiate payment");
          setLoading(false);
          setActivePackId(null);
        }
      } else {
        const res = await fetch("/api/payments/stripe/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            packId,
          }),
        });
        const data = await res.json();
        if (data.url) {
          window.location.href = data.url;
        } else {
          alert("Failed to initiate payment");
          setLoading(false);
          setActivePackId(null);
        }
      }
    } catch (err) {
      console.error(err);
      alert("Something went wrong");
      setLoading(false);
      setActivePackId(null);
    }
  };

  const getFeatures = (packId: string) => {
    switch (packId) {
      case "launch":
        return [
          "5 campaign briefs",
          "AI copy generation",
          "Targeting recommendations",
          "PDF brief download",
          "Valid for 6 months"
        ];
      case "growth":
        return [
          "20 campaign briefs",
          "Everything in Launch",
          "Priority AI processing",
          "Valid for 6 months"
        ];
      case "agency":
        return [
          "Unlimited briefs for 90 days",
          "Everything in Growth",
          "Multi-product campaigns",
          "Early access to new features"
        ];
      default:
        return [];
    }
  };

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)] relative">
      {/* Top nav bar */}
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
            <Link href="/dashboard" className="text-sm font-medium text-white/60 hover:text-white/90 transition-colors">Dashboard</Link>
            <Link href="/campaigns" className="text-sm font-medium text-white/60 hover:text-white/90 transition-colors">Campaigns</Link>
            
            {(credits > 0 || isUnlimited) && (
              <span className="text-xs text-white/50">
                {isUnlimited ? "Unlimited" : `${credits} briefs`}
              </span>
            )}
            
            {credits === 0 && !isUnlimited && (
              <Link href="/pricing" className="text-sm font-medium text-white/90 transition-colors">Buy Credits</Link>
            )}
            
            <Link href="/settings" className="text-sm font-medium text-white/60 hover:text-white/90 transition-colors">Settings</Link>
          </div>
          <div className="flex items-center gap-6">
            <Link
              href="/dashboard"
              className="text-xs font-medium text-white/40 hover:text-white/80 transition-colors no-underline"
            >
              Back to Dashboard
            </Link>
          </div>
        </div>
      </nav>

      {/* Background blur */}
      <div className="fixed top-0 left-1/4 w-[500px] h-[500px] bg-brand-600/5 rounded-full blur-[120px] pointer-events-none" />

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-16 relative">
        <div className="text-center mb-12 animate-fade-in-up">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white mb-4">
            Simple, transparent pricing
          </h1>
          <p className="text-base text-white/50 max-w-xl mx-auto">
            Buy credits when you need them. No subscriptions. No surprises.
          </p>

          {/* Credit Balance Display */}
          {(credits > 0 || isUnlimited) && (
            <div className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-surface-raised border border-border-subtle">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-brand-400">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4l3 3" />
              </svg>
              <span className="text-sm font-medium text-white/80">
                {isUnlimited 
                  ? `Unlimited access until ${new Date(unlimitedUntil!).toLocaleDateString()}`
                  : `Your current balance: ${credits} briefs remaining`}
              </span>
            </div>
          )}
        </div>

        {/* Currency Toggle */}
        <div className="flex justify-center mb-12 animate-fade-in-up-delay-1">
          <div className="inline-flex rounded-xl bg-surface-raised border border-border-subtle p-1">
            <button
              onClick={() => setCurrency("NGN")}
              className={`px-6 py-2 rounded-lg text-sm font-medium transition-colors ${
                currency === "NGN" 
                  ? "bg-brand-500 text-white shadow-lg shadow-brand-500/20" 
                  : "text-white/50 hover:text-white/80"
              }`}
            >
              Pay in NGN
            </button>
            <button
              onClick={() => setCurrency("USD")}
              className={`px-6 py-2 rounded-lg text-sm font-medium transition-colors ${
                currency === "USD" 
                  ? "bg-brand-500 text-white shadow-lg shadow-brand-500/20" 
                  : "text-white/50 hover:text-white/80"
              }`}
            >
              Pay in USD
            </button>
          </div>
        </div>

        {/* Pricing Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 animate-fade-in-up-delay-2">
          {CREDIT_PACKS.map((pack) => (
            <div 
              key={pack.id} 
              className={`relative rounded-2xl bg-surface-raised border p-8 flex flex-col ${
                pack.highlight 
                  ? "border-brand-500 md:-translate-y-4 shadow-xl shadow-brand-500/10" 
                  : "border-border-subtle"
              }`}
            >
              {pack.highlight && (
                <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 px-3 py-1 bg-brand-500 text-white text-[10px] font-bold uppercase tracking-wider rounded-full shadow-lg">
                  Most Popular
                </div>
              )}
              
              <div className="mb-6">
                <h3 className="text-lg font-semibold text-white mb-2">{pack.name}</h3>
                <p className="text-sm text-white/40 mb-6">{pack.description}</p>
                
                <div className="flex items-end gap-2 mb-2">
                  <span className="text-4xl font-bold text-white">
                    {currency === "NGN" 
                      ? formatCurrency(pack.price_ngn, "NGN") 
                      : formatCurrency(pack.price_usd, "USD")}
                  </span>
                </div>
                <div className="text-sm font-medium text-brand-400">
                  {pack.unlimited_days > 0 ? `Unlimited ${pack.unlimited_days} days` : `${pack.credits} briefs`}
                </div>
              </div>

              <ul className="space-y-4 mb-8 flex-1">
                {getFeatures(pack.id).map((feature, i) => (
                  <li key={i} className="flex items-start gap-3 text-sm text-white/70">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-success-400 shrink-0 mt-0.5">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>

              <button
                onClick={() => handleCheckout(pack.id)}
                disabled={loading}
                className={`w-full py-3 rounded-xl text-sm font-semibold transition-all ${
                  pack.highlight
                    ? "bg-brand-500 text-white hover:bg-brand-400 shadow-lg shadow-brand-500/20"
                    : "bg-white/5 text-white hover:bg-white/10"
                } disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center`}
              >
                {loading && activePackId === pack.id ? (
                  <svg className="animate-spin h-5 w-5 mr-2" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                ) : null}
                Get Started
              </button>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
