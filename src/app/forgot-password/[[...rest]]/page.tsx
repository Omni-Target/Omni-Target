import { SignIn } from "@clerk/nextjs";
import { AuthShell, authAppearance } from "@/components/auth";

export default function ForgotPasswordPage() {
  return (
    <AuthShell title="Reset your password" subtitle="We'll help you back into your account">
      <SignIn routing="path" path="/forgot-password" appearance={authAppearance} />
    </AuthShell>
  );
}
