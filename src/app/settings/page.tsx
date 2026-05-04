import { auth } from "@clerk/nextjs/server";
import { SignOutButton } from "@clerk/nextjs";
import { supabaseAdmin } from "@/lib/supabase";
import Link from "next/link";
import { SyncButton } from "@/components/SyncButton";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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

  console.log("Integration data:", JSON.stringify(integration));

  const shopifyConnected = 
    !!integration?.shopify_access_token ||
    !!integration?.shopify_store_url;
  const storeDomain = integration?.shopify_custom_domain || integration?.shopify_store_url || 'your store';

  return (
    <div className="min-h-screen bg-[var(--background)] px-4 py-12 sm:px-6 lg:px-8">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6">
          <Link 
            href="/dashboard"
            className="flex items-center gap-2 text-sm text-white/40 hover:text-white/70 transition-colors w-fit"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
            Back to Dashboard
          </Link>
        </div>

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

          {/* Card 2 — Store Intelligence */}
          <div className="p-6 rounded-2xl bg-white/[0.04] border border-border-subtle backdrop-blur-sm">
            <h2 className="text-lg font-semibold text-white mb-1">
              Store Intelligence
            </h2>
            <p className="text-sm text-white/40 mb-4">
              Your store data is automatically 
              synced from Shopify. We use this 
              to generate targeting recommendations 
              and campaign briefs.
            </p>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-success-400" />
              <span className="text-sm text-white/70">
                Auto-syncing from {storeDomain}
              </span>
            </div>
            <SyncButton />
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

    </div>
  );
}
