"use client";

import Link from "next/link";
import { Sparkles, Infinity as InfinityIcon, Plus } from "lucide-react";
import { useCredits } from "@/hooks/useCredits";
import { cn } from "@/lib/utils";

export function CreditsIndicator({ className }: { className?: string }) {
  const { credits, isUnlimited } = useCredits();

  return (
    <Link
      href="/pricing"
      className={cn(
        "group inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm font-medium shadow-xs transition-colors hover:border-border-strong hover:bg-surface-subtle",
        className,
      )}
      title="Buy credits"
    >
      {isUnlimited ? (
        <>
          <InfinityIcon className="size-4 text-brand-600" />
          <span className="text-foreground">Unlimited</span>
        </>
      ) : (
        <>
          <Sparkles className="size-4 text-brand-600" />
          <span className="text-foreground">
            {credits ?? "—"}
            <span className="ml-1 text-muted-foreground">
              credit{credits === 1 ? "" : "s"}
            </span>
          </span>
          <span className="ml-0.5 grid size-4 place-items-center rounded text-brand-600 transition-colors group-hover:bg-brand-50">
            <Plus className="size-3.5" />
          </span>
        </>
      )}
    </Link>
  );
}
