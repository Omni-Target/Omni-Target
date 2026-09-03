import { SignUp } from "@clerk/nextjs";
import { AuthShell, authAppearance, ShopifyLoginButton } from "@/components/auth";

export default function SignupPage() {
  return (
    <AuthShell title="Create your account" subtitle="Start scaling your Shopify ads">
      <div className="w-full max-w-[400px] space-y-5">
        <ShopifyLoginButton />

        <div className="relative flex items-center justify-center">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border" />
          </div>
          <span className="relative bg-surface px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            or continue with email
          </span>
        </div>

        <SignUp
          routing="path"
          path="/signup"
          fallbackRedirectUrl="/onboarding/connect-shopify"
          appearance={authAppearance}
        />
      </div>
    </AuthShell>
  );
}
