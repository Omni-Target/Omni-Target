import { SignIn } from "@clerk/nextjs";

export default function ForgotPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#09090f]">
      <SignIn routing="path" path="/forgot-password" />
    </div>
  );
}
