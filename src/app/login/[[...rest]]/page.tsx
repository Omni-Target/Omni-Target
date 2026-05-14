import { SignIn } from "@clerk/nextjs";

export default function LoginPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#0a0a1a] relative overflow-hidden">
      {/* Soft radial gradient glow behind the card */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-[#7c3aed] rounded-full blur-[150px] opacity-[0.12] pointer-events-none" />

      {/* Logo */}
      <div className="mb-8 z-10 flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-[#7c3aed] to-[#5b21b6] flex items-center justify-center shadow-lg shadow-[#7c3aed]/20">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
          </svg>
        </div>
        <span className="text-xl font-semibold tracking-tight text-white/90">
          omni-target
        </span>
      </div>

      <div className="z-10 w-full max-w-md px-4 sm:px-0 flex justify-center">
        <SignIn 
          fallbackRedirectUrl="/dashboard" 
          appearance={{
            variables: {
              colorBackground: "#111127",
              colorInputBackground: "#111127",
              colorText: "#ffffff",
              colorPrimary: "#7c3aed",
              colorInputText: "#ffffff",
              borderRadius: "0.5rem",
            },
            elements: {
              cardBox: "shadow-2xl rounded-2xl border border-white/[0.08]",
              card: "bg-[#111127] rounded-2xl m-0",
              formButtonPrimary: "rounded-full shadow-lg shadow-[#7c3aed]/20 font-medium transition-all",
              headerTitle: "text-white font-bold",
              headerSubtitle: "text-white/60",
              dividerLine: "bg-white/10",
              dividerText: "text-white/40",
              socialButtonsBlockButton: "border-white/10 text-white/90 hover:bg-white/5 transition-all",
              socialButtonsBlockButtonText: "font-medium",
              formFieldInput: "border-white/10 text-white focus:border-[#7c3aed] focus:ring-[#7c3aed]/20 bg-[#111127] transition-all",
              formFieldLabel: "text-white/70",
              footerActionText: "text-white/60",
              footerActionLink: "text-[#7c3aed] hover:text-[#8b5cf6] font-medium transition-colors",
              identityPreviewText: "text-white",
              identityPreviewEditButtonIcon: "text-[#7c3aed]",
            }
          }}
        />
      </div>
    </div>
  );
}
