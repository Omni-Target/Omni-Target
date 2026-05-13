import { SignUp } from "@clerk/nextjs";

export default function SignupPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#09090f]">
      <SignUp fallbackRedirectUrl="/dashboard" />
    </div>
  );
}
