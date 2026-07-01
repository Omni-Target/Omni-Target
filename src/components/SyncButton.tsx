"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

export function SyncButton() {
  const [syncing, setSyncing] = React.useState(false);
  const { toast } = useToast();

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await fetch("/api/store/data", { cache: "no-store" });
      if (!res.ok) throw new Error(`Sync failed (${res.status})`);
      window.location.reload();
    } catch (err) {
      console.error("[SyncButton] sync failed", err);
      setSyncing(false);
      toast({
        variant: "danger",
        title: "Sync failed",
        description: "We couldn't refresh your store data. Please try again.",
      });
    }
  };

  return (
    <Button variant="secondary" size="sm" isLoading={syncing} onClick={handleSync}>
      {!syncing && <RefreshCw className="size-4" />}
      {syncing ? "Syncing…" : "Force sync now"}
    </Button>
  );
}
