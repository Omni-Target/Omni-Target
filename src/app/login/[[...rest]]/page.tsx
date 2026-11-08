import Link from "next/link";
import { cookies } from "next/headers";
import { SignIn } from "@clerk/nextjs";
import { AuthShell, authAppearance, ShopifyLoginButton } from "@/components/auth";
import { AlertCircle, ArrowRight, Store } from "lucide-react";
import { PENDING_INSTALL_COOKIE, readPendingInstall } from "@/lib/shopify-oauth";

/** After sign-in/sign-up, re-run Shopify OAuth for the pending store, bound to the new session. */
const RESUME_SHOPIFY_INSTALL_URL = "/api/auth/shopify/connect?resume=1";

interface LoginPageProps {
  searchParams: Promise<{ error?: string; detail?: string; plan?: string; reason?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error, detail, plan, reason } = await searchParams;
  const pendingInstall = readPendingInstall((await cookies()).get(PENDING_INSTALL_COOKIE)?.value);
  const normalizedPlan = plan?.toLowerCase() || pendingInstall?.plan || null;

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to your Omni Target account"
    >
      <div className="w-full max-w-[400px] mx-auto space-y-4">
        <div className="flex items-center justify-between rounded-xl border border-brand-200/60 bg-brand-50/50 px-3.5 py-2.5 text-left text-xs">
          <span className="text-muted-foreground">New to Omni Target?</span>
          <Link
            href={normalizedPlan ? `/signup?plan=${encodeURIComponent(normalizedPlan)}` : "/signup"}
            className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:text-brand-800 transition-colors"
          >
            Scan your store free
            <ArrowRight className="size-3" />
          </Link>
        </div>

        {error && (
          <div className="flex items-start gap-2.5 rounded-xl border border-danger-200 bg-danger-50/70 p-3 text-left">
            <AlertCircle className="size-4 shrink-0 text-danger-600 mt-0.5" />
            <div className="space-y-0.5">
              <p className="text-xs font-semibold text-danger-900">
                {error === "shopify_auth_failed"
                  ? "Shopify authentication error"
                  : "Authentication notice"}
              </p>
              <p className="text-[11px] text-danger-700 leading-relaxed">
                {detail
                  ? decodeURIComponent(detail)
                  : "We could not complete your Shopify sign-in. Please try again or sign in with email."}
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
                {reason === "multiple_accounts"
                  ? "This store is connected to more than one Omni Target account. Sign in to the account you want to use and we'll continue."
                  : "Sign in (or create an account) and we'll link this store to it automatically."}
              </p>
            </div>
          </div>
        ) : (
          <ShopifyLoginButton plan={normalizedPlan} mode="login" />
        )}

        <SignIn
          routing="path"
          path="/login"
          fallbackRedirectUrl={
            normalizedPlan ? `/dashboard?plan=${encodeURIComponent(normalizedPlan)}` : "/dashboard"
          }
          forceRedirectUrl={pendingInstall ? RESUME_SHOPIFY_INSTALL_URL : undefined}
          signUpForceRedirectUrl={pendingInstall ? RESUME_SHOPIFY_INSTALL_URL : undefined}
          appearance={authAppearance}
        />
      </div>
    </AuthShell>
  );
}
