"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { ArrowRight } from "lucide-react";
import { Logo } from "@/components/shared/logo";

export function LandingHeader() {
  const { userId } = useAuth();

  return (
    <header className="fixed top-0 left-0 right-0 z-50 glass border-b border-border/40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Logo size={32} />
          <span className="font-bold text-xl tracking-tight">Omni Target</span>
        </div>

        <nav className="hidden md:flex items-center gap-8">
          <a href="#features" className="text-sm font-medium text-foreground/70 hover:text-foreground transition-colors">Features</a>
          <a href="#how-it-works" className="text-sm font-medium text-foreground/70 hover:text-foreground transition-colors">How it Works</a>
          <a href="#pricing" className="text-sm font-medium text-foreground/70 hover:text-foreground transition-colors">Pricing</a>
        </nav>

        <div className="flex items-center gap-4">
          {userId ? (
            <Link 
              href="/dashboard"
              className="px-4 py-2 rounded-full bg-surface-raised border border-border-subtle text-sm font-medium hover:bg-surface-overlay transition-all flex items-center gap-2"
            >
              Dashboard
              <ArrowRight className="w-4 h-4" />
            </Link>
          ) : (
            <>
              <Link href="/login" className="text-sm font-medium text-foreground/70 hover:text-foreground transition-colors">
                Sign in
              </Link>
              <Link 
                href="/signup"
                className="px-5 py-2 rounded-full bg-gradient-to-r from-brand-600 to-accent-600 text-sm font-semibold text-white shadow-brand hover:opacity-90 transition-all flex items-center gap-2"
              >
                Get Started
                <ArrowRight className="w-4 h-4" />
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
