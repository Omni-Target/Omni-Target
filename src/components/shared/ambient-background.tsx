import * as React from "react";
import { cn } from "@/lib/utils";

export interface AmbientBackgroundProps {
  className?: string;
  /** "grid" overlays a faint grid; "dots" overlays a dot field. */
  pattern?: "grid" | "dots" | "none";
  /** Tone of the ambient glow orbs. */
  variant?: "brand" | "subtle";
}

/** Decorative, non-interactive page backdrop for the light theme. */
export function AmbientBackground({
  className,
  pattern = "grid",
  variant = "brand",
}: AmbientBackgroundProps) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
    >
      {pattern === "grid" && (
        <div className="absolute inset-0 grid-background opacity-70" />
      )}
      {pattern === "dots" && (
        <div className="absolute inset-0 dot-background opacity-60" />
      )}
      <div
        className={cn(
          "absolute -top-32 left-1/2 h-[34rem] w-[44rem] -translate-x-1/2 rounded-full blur-3xl",
          variant === "brand"
            ? "bg-[radial-gradient(circle,rgba(9,9,15,0.06),transparent_65%)]"
            : "bg-[radial-gradient(circle,rgba(9,9,15,0.035),transparent_65%)]",
        )}
      />
      <div className="absolute -right-40 top-40 h-[28rem] w-[28rem] rounded-full bg-[radial-gradient(circle,rgba(9,9,15,0.04),transparent_65%)] blur-3xl" />
    </div>
  );
}
