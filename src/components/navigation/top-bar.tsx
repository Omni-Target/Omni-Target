"use client";

import Link from "next/link";
import { Menu, Plus } from "lucide-react";
import { Logo } from "@/components/shared/logo";
import { Button } from "@/components/ui/button";
import { CreditsIndicator } from "./credits-indicator";
import { UserMenu } from "./user-menu";

export function TopBar({ onMenuClick }: { onMenuClick: () => void }) {
  return (
    <header className="sticky top-0 z-40 flex h-16 items-center justify-between gap-3 border-b border-border-subtle bg-surface/80 px-4 backdrop-blur-md sm:px-6">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onMenuClick}
          aria-label="Open menu"
          className="grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground lg:hidden"
        >
          <Menu className="size-5" />
        </button>
        {/* Mobile navbar shows the logo mark only — saves horizontal space */}
        <Link href="/dashboard" className="lg:hidden" aria-label="Omni Target home">
          <Logo size={28} />
        </Link>
      </div>

      <div className="flex items-center gap-2 sm:gap-2.5">
        <Button asChild size="sm" variant="primary" className="hidden sm:inline-flex">
          <Link href="/campaigns">
            <Plus className="size-4" />
            New brief
          </Link>
        </Button>
        <CreditsIndicator />
        <div className="lg:hidden">
          <UserMenu variant="compact" />
        </div>
      </div>
    </header>
  );
}
