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

/** Full-screen two-panel layout: dark brand/progress rail + light workspace. */
export function SplitLayout({
  aside,
  children,
  className,
  asideClassName,
  contentClassName = "max-w-md",
}: SplitLayoutProps) {
  return (
    <div className={cn("flex min-h-screen w-full bg-background", className)}>
      {/* Left — dark immersive panel */}
      <aside
        className={cn(
          "relative hidden w-[42%] max-w-[34rem] shrink-0 flex-col overflow-hidden bg-gradient-ink text-ink-foreground lg:flex",
          asideClassName,
        )}
      >
        <div className="absolute inset-0 opacity-15 bg-[radial-gradient(circle_at_20%_20%,white_1px,transparent_1px)] bg-size-[26px_26px]" />
        <div
          aria-hidden
          className="absolute -left-24 top-1/3 h-80 w-80 rounded-full bg-[radial-gradient(circle,rgba(255,255,255,0.1),transparent_70%)] blur-3xl"
        />
        <div className="relative z-10 flex h-full flex-col p-10">{aside}</div>
      </aside>

      {/* Right — workspace */}
      <main className="relative flex min-h-screen flex-1 flex-col">
        {/* Mobile brand bar */}
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4 lg:hidden">
          <Wordmark size={26} />
        </div>
        <div className="flex flex-1 flex-col items-center justify-center px-5 py-10 sm:px-10">
          <div className={cn("w-full", contentClassName)}>{children}</div>
        </div>
      </main>
    </div>
  );
}
