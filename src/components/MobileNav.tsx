"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function MobileNav() {
  const pathname = usePathname();

  return (
    <div className="sm:hidden fixed bottom-0 left-0 right-0 z-50 bg-[#0f0f0f]/90 backdrop-blur-xl border-t border-border-subtle pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-center justify-around h-16 px-2 relative">
        <Link 
          href="/dashboard"
          className={`flex flex-col items-center justify-center w-full h-full gap-1 transition-colors ${
            pathname === "/dashboard" ? "text-brand-400" : "text-white/40 hover:text-white/70"
          }`}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="9" rx="1"/>
            <rect x="14" y="3" width="7" height="5" rx="1"/>
            <rect x="14" y="12" width="7" height="9" rx="1"/>
            <rect x="3" y="16" width="7" height="5" rx="1"/>
          </svg>
          <span className="text-[10px] font-medium">Dashboard</span>
        </Link>

        {/* Floating Action Button for New Brief */}
        <div className="relative -top-5 flex justify-center w-full">
          <Link
            href="/campaigns"
            className="flex items-center justify-center w-14 h-14 rounded-full bg-brand-500 text-white shadow-lg shadow-brand-500/20 border-[4px] border-[#0f0f0f] transition-transform hover:scale-105 active:scale-95"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </Link>
        </div>

        <Link 
          href="/settings"
          className={`flex flex-col items-center justify-center w-full h-full gap-1 transition-colors ${
            pathname === "/settings" ? "text-brand-400" : "text-white/40 hover:text-white/70"
          }`}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          <span className="text-[10px] font-medium">Settings</span>
        </Link>
      </div>
    </div>
  );
}
