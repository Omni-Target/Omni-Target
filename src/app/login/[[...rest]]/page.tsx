import Link from "next/link";
import { SignIn } from "@clerk/nextjs";
import { AuthShell, authAppearance, ShopifyLoginButton } from "@/components/auth";
import { AlertCircle, ArrowRight } from "lucide-react";

interface LoginPageProps {
  searchParams: Promise<{ error?: string; detail?: string; plan?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error, detail, plan } = await searchParams;
  const normalizedPlan = plan?.toLowerCase() || null;

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

        <ShopifyLoginButton plan={normalizedPlan} mode="login" />

        <SignIn
          routing="path"
          path="/login"
          fallbackRedirectUrl={
            normalizedPlan ? `/dashboard?plan=${encodeURIComponent(normalizedPlan)}` : "/dashboard"
          }
          appearance={authAppearance}
        />
      </div>
    </AuthShell>
  );
}
