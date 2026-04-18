"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function MetaDisconnectButton() {
  const router = useRouter();
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    try {
      const res = await fetch("/api/auth/meta/disconnect", { method: "DELETE" });
      if (res.ok) {
        router.refresh();
      }
    } catch (e) {
      console.error("Failed to disconnect Meta:", e);
    } finally {
      setIsDisconnecting(false);
    }
  };

  return (
    <button 
      onClick={handleDisconnect}
      disabled={isDisconnecting}
      className="text-xs text-white/40 hover:text-red-400 transition-colors underline underline-offset-2 shrink-0 self-start sm:self-center disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {isDisconnecting ? "Disconnecting..." : "Disconnect"}
    </button>
  );
}
