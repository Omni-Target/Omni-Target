"use client";

import * as React from "react";
import { Sidebar } from "@/components/navigation/sidebar";
import { TopBar } from "@/components/navigation/top-bar";
import { MobileNav } from "@/components/navigation/mobile-nav";
import { ToastProvider } from "@/components/ui/toast";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <ToastProvider>
      <div className="flex min-h-screen w-full bg-background">
        <Sidebar />
        <div className="flex min-h-screen min-w-0 flex-1 flex-col">
          <TopBar onMenuClick={() => setMobileOpen(true)} menuOpen={mobileOpen} />
          <main className="flex-1">{children}</main>
        </div>
        <MobileNav open={mobileOpen} onOpenChange={setMobileOpen} />
      </div>
    </ToastProvider>
  );
}
