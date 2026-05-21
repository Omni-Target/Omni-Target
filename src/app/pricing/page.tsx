"use client";

import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import { CREDIT_PACKS } from "@/lib/credit-packs";
import { Logo } from "@/components/Logo";

export default function PricingPage() {
  const { user } = useUser();
  const [loading, setLoading] = useState<string | null>(null);

  const handlePurchase = async (packId: string) => {
    setLoading(packId);
    try {
      const res = await fetch("/api/payments/paystack/initiate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          packId,
          email: user?.emailAddresses[0]?.emailAddress,
        }),
      });

      const data = await res.json();

      if (data.authorization_url) {
        window.location.href = data.authorization_url;
      } else {
        alert("Payment failed to initialise. Please try again.");
        setLoading(null);
      }
    } catch {
      alert("Something went wrong.");
      setLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      
      {/* Nav */}
      <nav className="border-b border-border-subtle px-6 h-16 flex items-center justify-between">
        <a href="/dashboard" className="text-sm text-white/40 hover:text-white/70 flex items-center gap-2">
          ← Back to Dashboard
        </a>
        <div className="flex items-center gap-2">
          <Logo className="w-6 h-6 text-[#9333ea]" />
          <span className="text-sm font-semibold text-white/90">
            omni-target
          </span>
        </div>
        <div />
      </nav>

      <main className="max-w-5xl mx-auto px-4 py-16">
        
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-3xl font-bold text-white mb-3">
            Simple, transparent pricing
          </h1>
          <p className="text-white/50 text-sm max-w-md mx-auto">
            Buy briefs when you need them. No subscriptions. No surprises. Credits valid for 6 months.
          </p>
        </div>

        {/* Pack cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {CREDIT_PACKS.map((pack) => (
            <div
              key={pack.id}
              className={`rounded-2xl p-6 border flex flex-col
                ${pack.highlight
                  ? "border-brand-500/50 bg-brand-500/5 relative"
                  : "border-border-subtle bg-surface"
                }`}
            >
              {pack.highlight && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="px-3 py-1 rounded-full bg-brand-500 text-white text-xs font-semibold">
                    Most Popular
                  </span>
                </div>
              )}

              <div className="mb-6">
                <h2 className="text-lg font-bold text-white mb-1">
                  {pack.name}
                </h2>
                <p className="text-xs text-white/40 mb-4">
                  {pack.tagline}
                </p>
                <div className="text-3xl font-bold text-white">
                  ₦{pack.price_ngn.toLocaleString()}
                </div>
                <div className="text-xs text-white/40 mt-1">
                  {pack.unlimited_days > 0
                    ? `${pack.unlimited_days} days unlimited access`
                    : `${pack.credits} campaign briefs`}
                </div>
              </div>

              <ul className="space-y-2 mb-8 flex-1">
                {pack.features.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm text-white/60">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-brand-400 flex-shrink-0">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>

              <button
                onClick={() => handlePurchase(pack.id)}
                disabled={loading === pack.id}
                className={`w-full py-3 rounded-xl font-semibold text-sm transition-colors disabled:opacity-50
                  ${pack.highlight
                    ? "bg-brand-500 hover:bg-brand-400 text-white"
                    : "bg-white/10 hover:bg-white/15 text-white"
                  }`}
              >
                {loading === pack.id ? "Redirecting..." : "Get Started"}
              </button>
            </div>
          ))}
        </div>

        {/* Trust signals */}
        <div className="mt-12 text-center text-xs text-white/30 space-y-1">
          <p>Secured by Paystack. Cards, bank transfer, USSD accepted.</p>
          <p>Credits never expire within 6 months of purchase.</p>
        </div>
      </main>
    </div>
  );
}
