import { cookies } from "next/headers";
import { SignUp } from "@clerk/nextjs";
import { AuthShell, authAppearance, ShopifyLoginButton } from "@/components/auth";
import { Sparkles, AlertCircle, Store } from "lucide-react";
import { PENDING_INSTALL_COOKIE, readPendingInstall } from "@/lib/shopify-oauth";

/** After sign-up/sign-in, re-run Shopify OAuth for the pending store, bound to the new session. */
const RESUME_SHOPIFY_INSTALL_URL = "/api/auth/shopify/connect?resume=1";

interface SignupPageProps {
  searchParams: Promise<{
    plan?: string;
    error?: string;
    detail?: string;
  }>;
}

const PLAN_BANNERS: Record<string, { title: string; subtitle: string; badge: string }> = {
  growth: {
    badge: "Growth Pack Selected",
    title: "You selected the Growth Pack (10 Creative Briefs)",
    subtitle: "Authorize via Shopify to activate.",
  },
  starter: {
    badge: "Starter Pack Selected",
    title: "You selected the Starter Pack (3 Creative Briefs)",
    subtitle: "Authorize via Shopify to activate.",
  },
  scale: {
    badge: "Scale Pack Selected",
    title: "You selected the Scale Pack (30 Creative Briefs)",
    subtitle: "Authorize via Shopify to activate.",
  },
  free: {
    badge: "Free Scan",
    title: "You selected the Free Plan (1 Free Creative Brief)",
    subtitle: "Connect your store to scan and generate your first brief.",
  },
};

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const { plan, error, detail } = await searchParams;
  const pendingInstall = readPendingInstall((await cookies()).get(PENDING_INSTALL_COOKIE)?.value);
  const normalizedPlan = plan?.toLowerCase() || pendingInstall?.plan || null;
  const planInfo = normalizedPlan ? PLAN_BANNERS[normalizedPlan] : null;

  return (
    <AuthShell
      title="Scan your store & get started"
      subtitle="Connect your Shopify store to generate your first AI ad briefs"
    >
      <div className="w-full max-w-[400px] mx-auto space-y-4">
        {planInfo && (
          <div className="rounded-xl border border-brand-200 bg-brand-50/80 p-3.5 text-left shadow-xs">
            <div className="flex items-center gap-1.5 mb-1 text-brand-700">
              <Sparkles className="size-3.5" />
              <span className="text-[11px] font-bold uppercase tracking-wider">
                {planInfo.badge}
              </span>
            </div>
            <p className="text-xs font-semibold text-foreground">{planInfo.title}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">{planInfo.subtitle}</p>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2.5 rounded-xl border border-danger-200 bg-danger-50/70 p-3 text-left">
            <AlertCircle className="size-4 shrink-0 text-danger-600 mt-0.5" />
            <div className="space-y-0.5">
              <p className="text-xs font-semibold text-danger-900">
                {error === "store_not_found" ? "Shopify store not found" : "Store connection notice"}
              </p>
              <p className="text-[11px] text-danger-700 leading-relaxed">
                {detail ? decodeURIComponent(detail) : "Please verify your store URL and try again."}
              </p>
            </div>
          </div>
        )}

        {pendingInstall ? (
          <div className="flex items-start gap-2.5 rounded-xl border border-brand-200 bg-brand-50/80 p-3 text-left">
            <Store className="size-4 shrink-0 text-brand-700 mt-0.5" />
            <div className="space-y-0.5">
              <p className="text-xs font-semibold text-foreground">
                Finish connecting {pendingInstall.shop}
              </p>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Create your Omni Target account (or sign in) and we&apos;ll link this store to it
                automatically.
              </p>
            </div>
          </div>
        ) : (
          <ShopifyLoginButton
            plan={normalizedPlan}
            mode="signup"
            buttonText="Scan your store with Shopify"
          />
        )}

        <SignUp
          routing="path"
          path="/signup"
          fallbackRedirectUrl={
            normalizedPlan ? `/onboarding?plan=${encodeURIComponent(normalizedPlan)}` : "/onboarding"
          }
          forceRedirectUrl={pendingInstall ? RESUME_SHOPIFY_INSTALL_URL : undefined}
          signInForceRedirectUrl={pendingInstall ? RESUME_SHOPIFY_INSTALL_URL : undefined}
          appearance={authAppearance}
        />
      </div>
    </AuthShell>
  );
}
