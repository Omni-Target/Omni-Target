"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";

export function MetaDisconnectButton() {
  const router = useRouter();
  const { toast } = useToast();
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const handleDisconnect = async () => {
    if (isDisconnecting) return;
    setIsDisconnecting(true);
    try {
      const res = await fetch("/api/auth/meta/disconnect", { method: "DELETE" });
      if (!res.ok) throw new Error(`Disconnect failed (${res.status})`);
      toast({ variant: "success", title: "Meta account disconnected" });
      router.refresh();
    } catch (e) {
      console.error("Failed to disconnect Meta:", e);
      toast({
        variant: "danger",
        title: "Couldn't disconnect",
        description: "Please try again in a moment.",
      });
    } finally {
      setIsDisconnecting(false);
    }
  };

  return (
    <button
      onClick={handleDisconnect}
      disabled={isDisconnecting}
      aria-busy={isDisconnecting || undefined}
      className="text-xs text-white/40 hover:text-danger-400 transition-colors underline underline-offset-2 shrink-0 self-start sm:self-center disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {isDisconnecting ? "Disconnecting..." : "Disconnect"}
    </button>
  );
}
