"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";

/**
 * Error boundary for routes outside the authenticated app (marketing,
 * onboarding, auth). Renders a full-screen, branded recovery UI. Next 16 passes
 * `unstable_retry` (not `reset`) to re-render the failed segment.
 */
export default function RootError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  React.useEffect(() => {
    console.error("[root] route error", error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <Logo className="size-9 text-brand-600" />
      <div className="flex size-14 items-center justify-center rounded-2xl border border-border-subtle bg-surface-subtle text-subtle-foreground">
        <AlertTriangle className="size-6" />
      </div>
      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold text-foreground">
          Something went wrong
        </h1>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          An unexpected error occurred. Please try again — if the problem
          persists, contact support.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button onClick={() => unstable_retry()}>
          <RefreshCw className="size-4" />
          Try again
        </Button>
        <Button variant="secondary" asChild>
          <Link href="/">Back to home</Link>
        </Button>
      </div>
    </main>
  );
}
