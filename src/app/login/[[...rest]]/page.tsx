import { SignIn } from "@clerk/nextjs";
import { AuthShell, authAppearance, ShopifyLoginButton } from "@/components/auth";
import { AlertCircle } from "lucide-react";

interface LoginPageProps {
  searchParams: Promise<{ error?: string; detail?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error, detail } = await searchParams;

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to your Omni Target account"
    >
      <div className="w-full max-w-[400px] mx-auto space-y-4">
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

        <ShopifyLoginButton />

        <SignIn
          routing="path"
          path="/login"
          fallbackRedirectUrl="/onboarding/connect-shopify"
          appearance={authAppearance}
        />
      </div>
    </AuthShell>
  );
}
