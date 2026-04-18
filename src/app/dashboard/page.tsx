"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { SignOutButton } from "@clerk/nextjs";



export default function DashboardPage() {
  const [excludePending, setExcludePending] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [metaConnected, setMetaConnected] = useState(false);

  useEffect(() => {
    fetch("/api/dashboard/stats", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        setStats(data);
        setMetaConnected(data.connected);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

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

        {/* Main State Logic */}
        {loading ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
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
        ) : !metaConnected ? (
          <div className="text-center py-20 rounded-xl bg-surface-raised border border-border-subtle mb-8">
            <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-4">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/40">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-white mb-3">
              Connect Meta to see your stats
            </h2>
            <p className="text-white/40 text-sm mb-6 max-w-md mx-auto">
              Your ROAS, spend, and campaign performance will appear here once your Meta Ads account is connected.
            </p>
            <Link href="/settings" className="px-6 py-3 rounded-xl bg-brand-500 text-white text-sm font-medium transition-colors hover:bg-brand-400">
              Connect Meta Ads →
            </Link>
          </div>
        ) : (
          <>
            {/* FX Alert */}
            {stats?.summary?.fxRate > 1500 && (
              <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
                <p className="text-sm text-amber-400">
                  ⚠️ Naira Alert: Meta is billing you at ₦{stats?.summary?.fxRate}/USD. Your actual ad spend in Naira is higher than Meta's dashboard shows.
                </p>
              </div>
            )}

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
                  <span className="text-[10px] text-white/25 bg-white/[0.03] px-2 py-1 rounded-md">Last 30 Days</span>
                </div>
                <p className="text-2xl font-bold text-white mb-1">
                  ₦{stats?.summary?.totalSpendNGN?.toLocaleString() || "0"}
                </p>
                <p className="text-xs text-white/40">Total Ad Spend</p>
                <div className="mt-3 flex items-center gap-1.5">
                  <span className="text-[10px] text-white/40 font-medium">
                    ${stats?.summary?.totalSpendUSD} USD at ₦{stats?.summary?.fxRate}/USD
                  </span>
                </div>
              </div>

              {/* Total Purchases */}
              <div className="rounded-xl bg-surface-raised border border-border-subtle p-5 animate-fade-in-up" style={{ animationDelay: "100ms" }}>
                <div className="flex items-center justify-between mb-4">
                  <div className="w-10 h-10 rounded-xl bg-success-500/10 flex items-center justify-center">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-success-400">
                      <line x1="12" y1="1" x2="12" y2="23" />
                      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                    </svg>
                  </div>
                </div>
                <p className="text-2xl font-bold text-white mb-1">
                  {stats?.summary?.totalPurchases?.toLocaleString() || 0}
                </p>
                <p className="text-xs text-white/40">Total Purchases</p>
              </div>

              {/* Total Impressions */}
              <div className="rounded-xl bg-surface-raised border border-border-subtle p-5 animate-fade-in-up" style={{ animationDelay: "200ms" }}>
                <div className="flex items-center justify-between mb-4">
                  <div className="w-10 h-10 rounded-xl bg-[#8b5cf6]/10 flex items-center justify-center">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[#8b5cf6]">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </div>
                </div>
                <p className="text-2xl font-bold text-white mb-1">
                  {stats?.summary?.totalImpressions?.toLocaleString() || 0}
                </p>
                <p className="text-xs text-white/40">Total Impressions</p>
              </div>

              {/* Average CTR */}
              <div className="rounded-xl bg-surface-raised border border-border-subtle p-5 animate-fade-in-up" style={{ animationDelay: "300ms" }}>
                <div className="flex items-center justify-between mb-4">
                  <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400">
                      <line x1="12" y1="20" x2="12" y2="10" />
                      <line x1="18" y1="20" x2="18" y2="4" />
                      <line x1="6" y1="20" x2="6" y2="16" />
                    </svg>
                  </div>
                </div>
                <p className="text-2xl font-bold text-white mb-1">
                  {stats?.summary?.averageCTR || "0.00"}%
                </p>
                <p className="text-xs text-white/40">Average CTR</p>
              </div>
            </div>
          </>
        )}

        {/* Live Campaigns Table */}
        <div className="rounded-xl bg-surface-raised border border-border-subtle overflow-hidden animate-fade-in-up-delay-2">
          <div className="px-6 py-4 border-b border-border-subtle flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white">Your Campaigns</h2>
              <p className="text-xs text-white/30 mt-0.5">{stats?.activeCampaigns?.length || 0} campaigns managed</p>
            </div>
            <Link
              href="/campaigns"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-brand-400 bg-brand-500/10 border border-brand-500/20 hover:bg-brand-500/20 transition-colors no-underline"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New Campaign
            </Link>
          </div>

          <div className="divide-y divide-border-subtle">
            {stats?.activeCampaigns?.length > 0 ? (
              stats.activeCampaigns.map((campaign: any) => {
                const metaMatch = stats?.campaigns?.find(
                  (c: any) => c.campaign_id === campaign.meta_campaign_id
                );
                
                const formatStatusBadge = (status: string) => {
                  switch (status.toLowerCase()) {
                    case "active":
                      return <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium border bg-success-500/10 border-success-500/20 text-success-400"><span className="w-1.5 h-1.5 rounded-full bg-success-400 animate-pulse" />Active</span>;
                    case "paused":
                      return <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium border bg-amber-500/10 border-amber-500/20 text-amber-400"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" />Paused</span>;
                    case "stopped":
                      return <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium border bg-error-500/10 border-error-500/20 text-error-400"><span className="w-1.5 h-1.5 rounded-full bg-error-400" />Stopped</span>;
                    default:
                      return <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium border bg-white/5 border-white/10 text-white/50 capitalize">{status}</span>;
                  }
                };

                const handleStatusChange = async (action: "pause" | "resume" | "stop") => {
                  if (action === "stop") {
                    if (!confirm("This will permanently stop the campaign in Meta. This cannot be undone. Continue?")) {
                      return;
                    }
                  }
                  try {
                    const res = await fetch(`/api/campaigns/${campaign.id}/status`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action })
                    });
                    if (res.ok) {
                      const data = await fetch("/api/dashboard/stats").then(r => r.json());
                      // Assuming functional state is set here dynamically without full reload,
                      // normally we could just reload, but we'll try to rely on state updates if outside mapping.
                      window.location.reload();
                    }
                  } catch (e) {
                    console.error("Status update error", e);
                  }
                };

                return (
                  <div key={campaign.id} className="grid grid-cols-1 sm:grid-cols-12 gap-4 px-6 py-4 hover:bg-white/[0.02] transition-colors duration-150">
                    <div className="sm:col-span-8 flex flex-col gap-2">
                       <div className="flex items-center gap-3">
                         <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-brand-500/20 to-brand-700/20 border border-brand-500/10 flex items-center justify-center flex-shrink-0">
                           <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-400">
                             <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                           </svg>
                         </div>
                         <div className="min-w-0 flex flex-col">
                           <div className="flex items-center gap-2">
                             <p className="text-sm font-semibold text-white truncate">{campaign.brand_name} — {campaign.campaign_goal}</p>
                           </div>
                           <div className="flex items-center gap-2 mt-1">
                             {formatStatusBadge(campaign.status)}
                             <span className="text-white/20 text-xs">•</span>
                             <span className="text-xs text-white/50">
                               {metaMatch?.spend ? `Spend: ₦${Math.round(metaMatch.spend * (stats.summary?.fxRate || 1)).toLocaleString()}` : "Daily Budget: —"}
                             </span>
                             <span className="text-white/20 text-xs">•</span>
                             <span className="text-xs text-white/50">
                               Launched: {new Date(campaign.launched_at || campaign.created_at).toLocaleDateString()}
                             </span>
                           </div>
                         </div>
                       </div>
                    </div>

                    <div className="sm:col-span-4 flex items-center sm:justify-end gap-2 mt-2 sm:mt-0">
                      {campaign.status === "active" && (
                        <button
                          onClick={() => handleStatusChange("pause")}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/20 transition-colors"
                        >
                          Pause
                        </button>
                      )}
                      
                      {campaign.status === "paused" && (
                        <button
                          onClick={() => handleStatusChange("resume")}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium text-success-400 bg-success-500/10 border border-success-500/20 hover:bg-success-500/20 transition-colors"
                        >
                          Resume
                        </button>
                      )}

                      {campaign.status !== "stopped" && (
                        <button
                          onClick={() => handleStatusChange("stop")}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium text-error-400 bg-transparent hover:bg-error-500/10 transition-colors"
                        >
                          Stop
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="p-8 text-center bg-white/[0.01]">
                <p className="text-sm text-white/50">No campaigns launched yet.</p>
              </div>
            )}
          </div>
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
