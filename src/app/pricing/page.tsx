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
            Omni Target
          </span>
        </div>
        <div />
      </nav>

      <main className="max-w-5xl mx-auto px-4 py-16">
        
        {/* Header */}
        {/* Header */}
        <div className="mb-12 max-w-[700px] text-center md:text-left">
          <div className="mb-4 font-mono text-[11px] uppercase tracking-[0.2em] text-[#a855f7]">
            Business Model
          </div>
          <h1
            className="font-serif font-black text-white"
            style={{ fontSize: "clamp(34px, 4.4vw, 56px)", lineHeight: 1.05, letterSpacing: "-0.015em" }}
          >
            Credit-first acquisition.
            <br />
            <span className="text-[#a855f7]">Earned subscriptions.</span>
          </h1>
        </div>

        {/* Pack cards */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4 lg:items-start">
          {CREDIT_PACKS.map((pack) => (
            <div
              key={pack.id}
              className={`flex flex-col rounded-2xl p-8 transition-transform border
                ${pack.highlight ? "lg:-translate-y-2" : ""}
                ${pack.dashed ? "border-dashed opacity-85" : ""}
              `}
              style={{
                borderColor: pack.highlight ? "var(--brand-500, #a855f7)" : "var(--border-subtle, rgba(255,255,255,0.1))",
                background: pack.highlight ? "rgba(168, 85, 247, 0.06)" : pack.dashed ? "rgba(168, 85, 247, 0.03)" : "transparent",
              }}
            >
              <div className="flex items-center justify-between mb-8">
                <h3 className="text-[18px] font-medium text-white">{pack.name}</h3>
                {pack.highlight && (
                  <span className="rounded-md border border-[#a855f7]/40 bg-[#a855f7]/15 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[#d8b4fe]">
                    Recommended
                  </span>
                )}
              </div>

              <div className="flex items-baseline gap-2 mb-6">
                <span
                  className="font-serif font-black text-[#a855f7]"
                  style={{ fontSize: 56, lineHeight: 1 }}
                >
                  ${pack.price_usd}
                </span>
                <span className="font-mono text-[12px] text-white/40">{pack.period}</span>
              </div>

              <p className="text-[14px] leading-[1.6] text-white/55 mb-8">
                {pack.description}
              </p>

              <ul className="space-y-3 mb-10 flex-1">
                {pack.features.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-[13px] text-white/60">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-[#a855f7] flex-shrink-0">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>

              <button
                onClick={() => handlePurchase(pack.id)}
                disabled={loading === pack.id}
                className={`w-full py-3 rounded-lg font-medium text-[15px] transition-colors disabled:opacity-50
                  ${pack.highlight
                    ? "bg-[#a855f7] hover:bg-[#9333ea] text-white"
                    : "border border-white/15 text-white hover:bg-white/5"
                  }`}
              >
                {loading === pack.id ? "Redirecting..." : pack.highlight ? "Get Starter Bundle" : pack.id === "scale" ? "Subscribe Now" : pack.id === "growth" ? "Get Growth Bundle" : "Generate Brief"}
              </button>
            </div>
          ))}
        </div>

        <div className="mt-10 flex justify-center">
          <div className="inline-flex items-center gap-3 rounded-full border border-white/5 bg-white/[0.02] px-5 py-2.5 text-[13px] text-white/60">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#a855f7]">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>
              Need more? Add extra briefs to any plan for <strong className="font-medium text-white">$9 / credit</strong>.
            </span>
          </div>
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
