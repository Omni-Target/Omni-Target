"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SyncButton() {
  const [syncing, setSyncing] = React.useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      isLoading={syncing}
      onClick={() => {
        setSyncing(true);
        fetch("/api/store/data", { cache: "no-store" })
          .then(() => window.location.reload())
          .catch(() => setSyncing(false));
      }}
    >
      {!syncing && <RefreshCw className="size-4" />}
      Force sync now
    </Button>
  );
}
