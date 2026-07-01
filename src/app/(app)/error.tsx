"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { PageContainer } from "@/components/layout/page-container";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";

/**
 * Error boundary for the authenticated app. Rendered inside <AppShell>, so the
 * sidebar/top bar remain available while the failed segment shows a recovery UI.
 * Next 16 passes `unstable_retry` (not `reset`) to re-render the segment.
 */
export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  React.useEffect(() => {
    console.error("[app] route error", error);
  }, [error]);

  return (
    <PageContainer width="default">
      <EmptyState
        icon={<AlertTriangle />}
        title="Something went wrong"
        description="We hit an unexpected error loading this page. You can try again, and if it keeps happening please contact support."
        action={
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button onClick={() => unstable_retry()}>
              <RefreshCw className="size-4" />
              Try again
            </Button>
            <Button variant="secondary" asChild>
              <Link href="/dashboard">Go to dashboard</Link>
            </Button>
          </div>
        }
      />
    </PageContainer>
  );
}
