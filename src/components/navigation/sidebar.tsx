"use client";

import Link from "next/link";
import { Sparkles, Infinity as InfinityIcon, Plus } from "lucide-react";
import { Wordmark } from "@/components/shared/logo";
import { Button } from "@/components/ui/button";
import { useCredits } from "@/hooks/useCredits";
import { SidebarNav } from "./sidebar-nav";
import { UserMenu } from "./user-menu";

function SidebarCredits() {
  const { credits, isUnlimited } = useCredits();
  return (
    <div className="rounded-2xl border border-brand-100 bg-gradient-to-br from-brand-50 to-surface p-4">
      <div className="flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-white">
          {isUnlimited ? (
            <InfinityIcon className="size-4" />
          ) : (
            <Sparkles className="size-4" />
          )}
        </span>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-foreground">
            {isUnlimited ? "Unlimited" : `${credits ?? "—"} credits`}
          </p>
          <p className="text-xs text-muted-foreground">Brief generation</p>
        </div>
      </div>
      {!isUnlimited && (
        <Button asChild size="sm" className="mt-3 w-full" variant="primary">
          <Link href="/pricing">
            <Plus className="size-4" />
            Get more credits
          </Link>
        </Button>
      )}
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-screen w-[16.5rem] shrink-0 flex-col border-r border-border-subtle bg-surface lg:flex">
      <div className="flex h-16 items-center px-5">
        <Link href="/dashboard" className="inline-flex">
          <Wordmark size={28} />
        </Link>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2">
        <SidebarNav showDescriptions />
      </div>
      <div className="space-y-3 px-3 pb-4">
        <SidebarCredits />
        <UserMenu variant="full" />
      </div>
    </aside>
  );
}
