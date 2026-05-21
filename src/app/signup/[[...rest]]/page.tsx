import { SignUp } from "@clerk/nextjs";
import { Logo } from "@/components/Logo";

export default function SignupPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#09090f] relative overflow-hidden">
      {/* Background Effects */}
      <div className="grid-background absolute inset-0 z-0" />
      <div className="hero-glow top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-30" />

      {/* Logo Section */}
      <div className="mb-8 z-10 flex flex-col items-center gap-4 animate-fade-in-up">
        <div className="w-16 h-16 flex items-center justify-center animate-glow-pulse">
          <Logo className="w-16 h-16 text-[#a855f7]" />
        </div>
        <div className="flex flex-col items-center">
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            omni-target
          </h1>
          <p className="text-white/50 text-sm font-medium mt-1">Start scaling your Shopify ads</p>
        </div>
      </div>

      <div className="z-10 w-full max-w-md px-4 sm:px-0 flex justify-center animate-fade-in-up-delay-1">
        <SignUp 
          routing="path"
          path="/signup"
          fallbackRedirectUrl="/onboarding/connect-shopify" 
          appearance={{
            variables: {
              colorBackground: "#111127",
              colorInputBackground: "#16162d",
              colorText: "#ffffff",
              colorTextSecondary: "#a1a1aa",
              colorPrimary: "#7c3aed",
              colorInputText: "#ffffff",
              borderRadius: "0.75rem",
            },
            elements: {
              cardBox: "glass-raised border-white/[0.08] shadow-2xl",
              card: "bg-transparent m-0",
              headerTitle: "text-white font-bold text-xl !text-white",
              headerSubtitle: "text-white/60 !text-white/60",
              formButtonPrimary: "rounded-xl shadow-lg shadow-[#7c3aed]/20 font-semibold transition-all hover:scale-[1.02] active:scale-[0.98] bg-gradient-to-r from-[#7c3aed] to-[#6d28d9] py-6",
              socialButtonsBlockButton: "border-white/10 text-white hover:bg-white/5 transition-all rounded-xl py-6 !text-white",
              socialButtonsBlockButtonText: "font-medium !text-white",
              formFieldInput: "border-white/10 text-white focus:border-[#7c3aed] focus:ring-[#7c3aed]/20 bg-white/5 transition-all rounded-xl h-11 !text-white !bg-[#16162d]",
              formFieldLabel: "text-white/60 text-xs uppercase tracking-wider font-bold mb-1.5 !text-white/60",
              footerActionText: "text-white/50 !text-white/50",
              footerActionLink: "text-[#7c3aed] hover:text-[#8b5cf6] font-semibold transition-colors !text-[#7c3aed]",
              identityPreviewText: "text-white !text-white",
              identityPreviewEditButtonIcon: "text-[#7c3aed]",
              dividerLine: "bg-white/10",
              dividerText: "text-white/40 text-[10px] uppercase tracking-widest font-bold !text-white/40",
            }
          }}
        />
      </div>
    </div>
  );
}
