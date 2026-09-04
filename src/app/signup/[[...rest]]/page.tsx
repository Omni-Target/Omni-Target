import { SignUp } from "@clerk/nextjs";
import { AuthShell, authAppearance, ShopifyLoginButton } from "@/components/auth";

export default function SignupPage() {
  return (
    <AuthShell title="Create your account" subtitle="Start scaling your Shopify ads">
      <div className="w-full max-w-[400px] mx-auto space-y-4">
        <ShopifyLoginButton />

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
