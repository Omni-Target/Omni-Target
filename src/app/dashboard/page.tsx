"use client";

import React, { useState } from "react";
import Link from "next/link";
import { SignOutButton } from "@clerk/nextjs";

const CAMPAIGNS = [
  {
    name: "Detty December — Broad Match",
    status: "Active",
    spend: "₦98,500",
    purchases: 28,
    revenue: "₦562,500",
    roas: "5.7x",
    roasColor: "text-success-400",
    statusColor: "bg-success-500/10 border-success-500/20 text-success-400",
    statusDot: "bg-success-400",
  },
  {
    name: "New Year Collection — Lookalike",
    status: "Active",
    spend: "₦51,500",
    purchases: 9,
    revenue: "₦112,500",
    roas: "2.2x",
    roasColor: "text-warning-400",
    statusColor: "bg-success-500/10 border-success-500/20 text-success-400",
    statusDot: "bg-success-400",
  },
];

export default function DashboardPage() {
  const [excludePending, setExcludePending] = useState(false);

  const totalSpend = 150000;
  const baseRevenue = 675000;
  const pendingAmount = 67500;
  const revenue = excludePending ? baseRevenue - pendingAmount : baseRevenue;
  const roas = (revenue / totalSpend).toFixed(1);
  const costPerPurchase = Math.round(totalSpend / 37);

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
              New Campaign
            </Link>
          </div>
        </div>
      </nav>

      {/* Background */}
      <div className="fixed top-0 left-1/4 w-[500px] h-[500px] bg-brand-600/5 rounded-full blur-[120px] pointer-events-none" />
      <div className="fixed bottom-0 right-1/3 w-[400px] h-[400px] bg-success-500/3 rounded-full blur-[100px] pointer-events-none" />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 relative">
        {/* Header */}
        <div className="mb-8 animate-fade-in-up">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-1">
            Performance Dashboard
          </h1>
          <p className="text-sm text-white/40">
            Real-time truth engine for your Meta Ads · Last synced 2 min ago
          </p>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {/* Total Ad Spend */}
          <div className="rounded-xl bg-surface-raised border border-border-subtle p-5 animate-fade-in-up">
            <div className="flex items-center justify-between mb-4">
              <div className="w-10 h-10 rounded-xl bg-brand-500/10 flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-400">
                  <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
                  <polyline points="17 6 23 6 23 12" />
                </svg>
              </div>
              <span className="text-[10px] text-white/25 bg-white/[0.03] px-2 py-1 rounded-md">7 days</span>
            </div>
            <p className="text-2xl font-bold text-white mb-1">₦{totalSpend.toLocaleString()}</p>
            <p className="text-xs text-white/40">Total Ad Spend</p>
            <div className="mt-3 flex items-center gap-1.5">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-brand-400">
                <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
              </svg>
              <span className="text-[10px] text-brand-400 font-medium">+12% vs last week</span>
            </div>
          </div>

          {/* Shopify Revenue */}
          <div className="rounded-xl bg-surface-raised border border-border-subtle p-5 animate-fade-in-up" style={{ animationDelay: "100ms" }}>
            <div className="flex items-center justify-between mb-4">
              <div className="w-10 h-10 rounded-xl bg-success-500/10 flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-success-400">
                  <line x1="12" y1="1" x2="12" y2="23" />
                  <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
              </div>
              {/* Toggle */}
              <div className="flex items-center gap-2">
                <button
                  id="exclude-pending-toggle"
                  onClick={() => setExcludePending(!excludePending)}
                  className={`relative w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer ${
                    excludePending ? "bg-brand-500" : "bg-white/10"
                  }`}
                  aria-label="Exclude Pending Bank Transfers"
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200 ${
                      excludePending ? "translate-x-4" : ""
                    }`}
                  />
                </button>
              </div>
            </div>
            <p className="text-2xl font-bold text-white mb-1">₦{revenue.toLocaleString()}</p>
            <p className="text-xs text-white/40">Shopify Revenue</p>
            <div className="mt-3 flex items-center gap-1.5">
              <span className="text-[10px] text-white/30 font-medium">
                {excludePending ? "Excl. ₦67,500 pending" : "Exclude Pending Bank Transfers"}
              </span>
            </div>
          </div>

          {/* True ROAS */}
          <div className="rounded-xl bg-surface-raised border border-success-500/20 p-5 animate-fade-in-up animate-glow-pulse" style={{ animationDelay: "200ms", boxShadow: "0 0 30px rgba(16, 185, 129, 0.05)" }}>
            <div className="flex items-center justify-between mb-4">
              <div className="w-10 h-10 rounded-xl bg-success-500/15 flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-success-400">
                  <circle cx="12" cy="12" r="10" />
                  <circle cx="12" cy="12" r="6" />
                  <circle cx="12" cy="12" r="2" />
                </svg>
              </div>
              <span className="text-[10px] text-success-400 bg-success-500/10 px-2 py-1 rounded-md font-medium">★ Key Metric</span>
            </div>
            <p className="text-3xl font-bold text-success-400 mb-1">{roas}x</p>
            <p className="text-xs text-white/40">True ROAS</p>
            <div className="mt-3 flex items-center gap-1.5">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-success-400">
                <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
              </svg>
              <span className="text-[10px] text-success-400 font-medium">
                {excludePending ? "Cleared revenue only" : "Including all revenue"}
              </span>
            </div>
          </div>

          {/* Cost Per Purchase */}
          <div className="rounded-xl bg-surface-raised border border-border-subtle p-5 animate-fade-in-up" style={{ animationDelay: "300ms" }}>
            <div className="flex items-center justify-between mb-4">
              <div className="w-10 h-10 rounded-xl bg-brand-500/10 flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-400">
                  <circle cx="9" cy="21" r="1" />
                  <circle cx="20" cy="21" r="1" />
                  <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
                </svg>
              </div>
              <span className="text-[10px] text-white/25 bg-white/[0.03] px-2 py-1 rounded-md">37 purchases</span>
            </div>
            <p className="text-2xl font-bold text-white mb-1">₦{costPerPurchase.toLocaleString()}</p>
            <p className="text-xs text-white/40">Cost Per Purchase</p>
            <div className="mt-3 flex items-center gap-1.5">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-success-400" style={{ transform: "rotate(180deg)" }}>
                <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
              </svg>
              <span className="text-[10px] text-success-400 font-medium">-8% vs last week</span>
            </div>
          </div>
        </div>

        {/* Live Campaigns Table */}
        <div className="rounded-xl bg-surface-raised border border-border-subtle overflow-hidden animate-fade-in-up-delay-2">
          <div className="px-6 py-4 border-b border-border-subtle flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white">Live Campaigns</h2>
              <p className="text-xs text-white/30 mt-0.5">{CAMPAIGNS.length} campaigns running</p>
            </div>
            <Link
              href="/campaigns"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-brand-400 bg-brand-500/10 border border-brand-500/20 hover:bg-brand-500/20 transition-colors no-underline"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add Campaign
            </Link>
          </div>

          {/* Table header */}
          <div className="hidden sm:grid grid-cols-12 gap-4 px-6 py-3 text-xs text-white/30 font-medium uppercase tracking-wider border-b border-border-subtle bg-white/[0.01]">
            <div className="col-span-3">Campaign</div>
            <div className="col-span-1">Status</div>
            <div className="col-span-2 text-right">Spend</div>
            <div className="col-span-1 text-right">Purchases</div>
            <div className="col-span-2 text-right">Revenue</div>
            <div className="col-span-1 text-right">ROAS</div>
            <div className="col-span-2 text-right">Actions</div>
          </div>

          {/* Table rows */}
          {CAMPAIGNS.map((campaign, index) => (
            <div
              key={index}
              className="grid grid-cols-1 sm:grid-cols-12 gap-3 sm:gap-4 px-6 py-4 border-b border-border-subtle last:border-b-0 hover:bg-white/[0.02] transition-colors duration-150"
            >
              {/* Campaign name */}
              <div className="sm:col-span-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-brand-500/20 to-brand-700/20 border border-brand-500/10 flex items-center justify-center flex-shrink-0">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-400">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{campaign.name}</p>
                  <p className="text-[10px] text-white/25 sm:hidden">{campaign.status} · {campaign.spend} spent</p>
                </div>
              </div>

              {/* Status */}
              <div className="hidden sm:flex sm:col-span-1 items-center">
                <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium border ${campaign.statusColor}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${campaign.statusDot} animate-pulse`} />
                  {campaign.status}
                </span>
              </div>

              {/* Spend */}
              <div className="hidden sm:flex sm:col-span-2 items-center justify-end">
                <span className="text-sm text-white/70 font-mono">{campaign.spend}</span>
              </div>

              {/* Purchases */}
              <div className="hidden sm:flex sm:col-span-1 items-center justify-end">
                <span className="text-sm text-white/70 font-mono">{campaign.purchases}</span>
              </div>

              {/* Revenue */}
              <div className="hidden sm:flex sm:col-span-2 items-center justify-end">
                <span className="text-sm text-white/70 font-mono">{campaign.revenue}</span>
              </div>

              {/* ROAS */}
              <div className="hidden sm:flex sm:col-span-1 items-center justify-end">
                <span className={`text-sm font-bold font-mono ${campaign.roasColor}`}>{campaign.roas}</span>
              </div>

              {/* Actions */}
              <div className="sm:col-span-2 flex items-center justify-end">
                <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white/50 bg-white/[0.04] border border-border-subtle hover:bg-white/[0.08] hover:text-white/80 transition-all duration-200 cursor-pointer">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  View Insights
                </button>
              </div>

              {/* Mobile stats */}
              <div className="sm:hidden grid grid-cols-3 gap-2">
                <div className="bg-white/[0.03] rounded-lg px-3 py-2 text-center">
                  <p className="text-xs font-semibold text-white">{campaign.purchases}</p>
                  <p className="text-[10px] text-white/30">Purchases</p>
                </div>
                <div className="bg-white/[0.03] rounded-lg px-3 py-2 text-center">
                  <p className="text-xs font-semibold text-white">{campaign.revenue}</p>
                  <p className="text-[10px] text-white/30">Revenue</p>
                </div>
                <div className="bg-white/[0.03] rounded-lg px-3 py-2 text-center">
                  <p className={`text-xs font-bold ${campaign.roasColor}`}>{campaign.roas}</p>
                  <p className="text-[10px] text-white/30">ROAS</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Footer insight */}
        <div className="mt-6 rounded-xl bg-brand-500/5 border border-brand-500/10 p-5 animate-fade-in-up-delay-3">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-brand-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-400">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-white mb-1">AI Insight</p>
              <p className="text-xs text-white/40 leading-relaxed">
                Your &quot;Detty December&quot; campaign is outperforming by 2.6x. Consider increasing its daily budget by 30% to scale while ROAS remains above 5x. Your cost-per-purchase dropped 8% this week — a sign of strong audience learning.
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
