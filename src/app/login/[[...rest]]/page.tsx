import { SignIn } from "@clerk/nextjs";
import { AuthShell, authAppearance } from "@/components/auth";

export default function LoginPage() {
  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your Omni Target account">
      <SignIn
        routing="path"
        path="/login"
        fallbackRedirectUrl="/onboarding/connect-shopify"
        appearance={authAppearance}
      />
    </AuthShell>
  );
}
