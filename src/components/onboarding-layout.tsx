import React from "react";
import { Logo } from "./Logo";

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-12 relative overflow-hidden">
      {/* Background gradient orbs */}
      <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-brand-600/5 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-0 right-1/4 w-[400px] h-[400px] bg-brand-400/5 rounded-full blur-[100px] pointer-events-none" />

      {/* Logo */}
      <div className="mb-10 animate-fade-in-up flex items-center gap-3">
        <div className="w-9 h-9 flex items-center justify-center">
          <Logo className="w-9 h-9 text-[#9333ea]" />
        </div>
        <span className="text-lg font-semibold tracking-tight text-white/90">
          omni-target
        </span>
      </div>

      {/* Content card */}
      <div className="w-full max-w-lg relative">
        <div className="absolute inset-0 rounded-2xl bg-gradient-to-b from-border-subtle/50 to-transparent p-px pointer-events-none">
          <div className="w-full h-full rounded-2xl bg-surface" />
        </div>
        <div className="relative rounded-2xl bg-surface-raised/80 backdrop-blur-xl border border-border-subtle p-8 sm:p-10 shadow-2xl shadow-black/40">
          {children}
        </div>
      </div>

      {/* Footer */}
      <p className="mt-8 text-xs text-white/30 animate-fade-in-up-delay-4">
        Secured by 256-bit encryption · SOC 2 Compliant
      </p>
    </div>
  );
}
