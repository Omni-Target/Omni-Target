import { SignIn } from "@clerk/nextjs";

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#09090f]">
      <SignIn fallbackRedirectUrl="/dashboard" />
    </div>
  );
}
