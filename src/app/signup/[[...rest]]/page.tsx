import { SignUp } from "@clerk/nextjs";
import { AuthShell, authAppearance } from "@/components/auth";

export default function SignupPage() {
  return (
    <AuthShell title="Create your account" subtitle="Start scaling your Shopify ads">
      <SignUp
        routing="path"
        path="/signup"
        fallbackRedirectUrl="/onboarding/connect-shopify"
        appearance={authAppearance}
      />
    </AuthShell>
  );
}
