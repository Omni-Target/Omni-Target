import * as React from "react";
import { cn } from "@/lib/utils";
import { Wordmark } from "@/components/shared/logo";

export interface SplitLayoutProps {
  /** Content for the dark left panel (brand, progress, tips). */
  aside: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  asideClassName?: string;
  /** Max-width wrapper for the right-panel content. Defaults to `max-w-md`. */
  contentClassName?: string;
}

/**
 * Full-screen two-panel workspace: a FIXED dark brand/progress rail on the left
 * that never scrolls, and an INDEPENDENTLY scrollable light workspace on the
 * right. The viewport height is locked (`h-screen` + `overflow-hidden`) so long
 * content (forms, audit reports) scrolls inside the right panel while the left
 * panel stays pinned as a persistent guide.
 */
export function SplitLayout({
  aside,
  children,
  className,
  asideClassName,
  contentClassName = "max-w-md",
}: SplitLayoutProps) {
  return (
    <div
      className={cn(
        "flex h-screen w-full overflow-hidden bg-background",
        className,
      )}
    >
      {/* Left — fixed dark immersive panel (does not scroll) */}
      <aside
        className={cn(
          "relative hidden h-full w-[42%] max-w-[34rem] shrink-0 flex-col overflow-hidden bg-gradient-ink text-ink-foreground lg:flex",
          asideClassName,
        )}
      >
        <div className="absolute inset-0 opacity-15 bg-[radial-gradient(circle_at_20%_20%,var(--color-ink-foreground)_1px,transparent_1px)] bg-size-[26px_26px]" />
        <div
          aria-hidden
          className="absolute -left-24 top-1/3 h-80 w-80 rounded-full bg-[radial-gradient(circle,color-mix(in_srgb,var(--color-brand-500)_28%,transparent),transparent_70%)] blur-3xl"
        />
        <div className="relative z-10 flex h-full flex-col p-10">{aside}</div>
      </aside>

      {/* Right — independently scrollable workspace */}
      <main className="relative h-screen flex-1 overflow-y-auto">
        {/* Mobile brand bar — sticky so it stays put while the panel scrolls */}
        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-border-subtle bg-background/85 px-5 py-4 backdrop-blur lg:hidden">
          <Wordmark size={26} />
        </div>
        <div className="flex min-h-full flex-col items-center justify-center px-5 py-10 sm:px-10">
          <div className={cn("w-full", contentClassName)}>{children}</div>
        </div>
      </main>
    </div>
  );
}
