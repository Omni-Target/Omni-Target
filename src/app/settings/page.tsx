import { auth } from "@clerk/nextjs/server";
import { SignOutButton } from "@clerk/nextjs";
import { supabaseAdmin } from "@/lib/supabase";
import Link from "next/link";
import { MetaDisconnectButton } from "@/components/MetaDisconnectButton";
import { MetaSelectors } from "@/components/MetaSelectors";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { userId } = await auth();
  const params = await searchParams;
  const metaStatus = params.meta as string | undefined;
  
  const { data: integration } = await 
    supabaseAdmin
      .from("user_integrations")
      .select("*")
      .eq("clerk_user_id", userId)
      .single();

  const metaConnected = 
    !!integration?.meta_access_token;
  const shopifyConnected = 
    !!integration?.shopify_access_token ||
    !!integration?.shopify_store_url;

  const allAccounts = integration?.meta_ad_accounts || [];
  const selectedAccountId = integration?.meta_selected_account_id || integration?.meta_ad_account_id;
  const allPages = integration?.meta_pages || [];
  const selectedPageId = integration?.meta_page_id;

  return (
    <div className="min-h-screen bg-[var(--background)] px-4 py-12 sm:px-6 lg:px-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-8">
          Settings
        </h1>

        <div className="space-y-6">
          {/* Card 1 — Shopify Integration */}
          <div className="p-6 rounded-2xl bg-white/[0.04] border border-border-subtle backdrop-blur-sm">
            <h2 className="text-lg font-semibold text-white mb-4">Shopify Store</h2>
            {shopifyConnected ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]"></div>
                  <div>
                    <p className="text-sm font-medium text-white">{integration.shopify_store_url || 'Store connected'}</p>
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-green-500/10 text-green-400 text-xs font-medium border border-green-500/20 mt-1">
                      Connected
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <p className="text-sm text-white/50">Your store is not connected yet.</p>
                <Link 
                  href="/onboarding/connect-shopify"
                  className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 rounded-xl transition-colors shrink-0"
                >
                  Connect Store
                </Link>
              </div>
            )}
          </div>

          {/* Card 2 — Meta Ads Integration */}
          <div className="p-6 rounded-2xl bg-white/[0.04] border border-border-subtle backdrop-blur-sm">
            <h2 className="text-lg font-semibold text-white mb-4">Meta Ads Account</h2>
            {metaConnected ? (
              !integration.meta_page_id ? (
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex-1 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm leading-relaxed">
                    ⚠️ No Facebook Page found. 
                    You need a Facebook Page to run ads. 
                    Create one at facebook.com/pages/create 
                    then reconnect your Meta account.
                  </div>
                  <div className="shrink-0 self-start sm:self-center">
                    <MetaDisconnectButton />
                  </div>
                </div>
              ) : (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="flex items-start sm:items-center gap-3">
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)] mt-1.5 sm:mt-0 shrink-0"></div>
                    <div>
                      {integration.meta_pixel_id && (
                        <p className="text-sm font-medium text-white">Pixel: {integration.meta_pixel_id}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-2 mt-1.5">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-green-500/10 text-green-400 text-xs font-medium border border-green-500/20">
                        Connected
                      </span>
                      {integration.pixel_health === "none" && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-red-500/10 text-red-400 text-xs font-medium border border-red-500/20">
                          No Pixel
                        </span>
                      )}
                      {integration.pixel_health === "unknown" && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-400 text-xs font-medium border border-amber-500/20">
                          Pixel Unverified
                        </span>
                      )}
                      {integration.pixel_health === "broken" && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-red-500/10 text-red-400 text-xs font-medium border border-red-500/20">
                          Pixel Issues
                        </span>
                      )}
                      {integration.pixel_health === "healthy" && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-green-500/10 text-green-400 text-xs font-medium border border-green-500/20">
                          Pixel Healthy
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col sm:items-end gap-3 shrink-0 self-start">
                    <Link 
                      href="/onboarding/audit"
                      className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 rounded-xl transition-colors"
                    >
                      Run Pixel Audit
                    </Link>
                    <MetaDisconnectButton />
                  </div>
                </div>

                <div className="pl-5 border-t border-white/5 pt-4 mt-2">
                  <MetaSelectors 
                    allAccounts={allAccounts}
                    selectedAccountId={selectedAccountId}
                    allPages={allPages}
                    selectedPageId={selectedPageId}
                  />
                </div>
              </div>
              )
            ) : (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                 <p className="text-sm text-white/50">Connect your Meta Ads account to launch campaigns.</p>
                 <Link 
                  href="/api/auth/meta/connect"
                  className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 rounded-xl transition-colors shrink-0 group"
                >
                  Connect Meta Ads
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="ml-2 transition-transform duration-200 group-hover:translate-x-0.5"
                  >
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </Link>
              </div>
            )}
          </div>
          
          {/* Account Section (Danger Zone) */}
          <div className="p-6 rounded-2xl bg-white/[0.04] border border-border-subtle backdrop-blur-sm mt-8">
            <h2 className="text-lg font-semibold text-white mb-4">Account</h2>
            
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="text-sm text-white/50">
                Manage your session or account data.
              </div>
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-6">
                <SignOutButton>
                  <button className="text-sm font-medium text-white hover:text-white/80 transition-colors px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl border border-white/10">
                    Sign Out
                  </button>
                </SignOutButton>

                <div 
                  className="text-sm text-white/30 cursor-not-allowed border-b border-transparent hover:border-white/30 transition-colors"
                  title="Contact support to delete your account"
                >
                  Delete my account
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      {metaStatus && (
        <div className="fixed bottom-6 right-6 animate-fade-in-up z-50">
          <div className={`px-4 py-3 rounded-xl border shadow-lg backdrop-blur-md flex items-center gap-3 text-sm font-medium ${
            metaStatus === "connected" ? "bg-green-500/10 border-green-500/20 text-green-400" :
            metaStatus === "denied" ? "bg-amber-500/10 border-amber-500/20 text-amber-400" :
            "bg-red-500/10 border-red-500/20 text-red-400"
          }`}>
            {metaStatus === "connected" && (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
            )}
            {metaStatus === "denied" && (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
            )}
            {metaStatus === "error" && (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
            )}
            
            <span>
              {metaStatus === "connected" && "Meta Ads connected successfully"}
              {metaStatus === "denied" && "Meta connection was cancelled"}
              {metaStatus === "error" && "Something went wrong. Please try again."}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
