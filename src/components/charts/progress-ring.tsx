import * as React from "react";
import { cn } from "@/lib/utils";
import { clamp } from "@/lib/utils";

export interface ProgressRingProps {
  value: number;
  max?: number;
  size?: number;
  thickness?: number;
  tone?: string;
  trackClassName?: string;
  className?: string;
  children?: React.ReactNode;
}

/** Thin circular progress indicator; color via `tone` (text color class). */
export function ProgressRing({
  value,
  max = 100,
  size = 44,
  thickness = 4,
  tone = "text-brand-600",
  trackClassName = "text-surface-muted",
  className,
  children,
}: ProgressRingProps) {
  const pct = clamp((value / max) * 100, 0, 100);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  return (
    <div
      className={cn("relative inline-grid place-items-center", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={thickness}
          className={trackClassName}
          stroke="currentColor"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className={tone}
          stroke="currentColor"
          style={{ transition: "stroke-dashoffset 0.9s cubic-bezier(0.16,1,0.3,1)" }}
        />
      </svg>
      {children && (
        <div className="absolute inset-0 grid place-items-center text-[0.625rem] font-semibold text-foreground">
          {children}
        </div>
      )}
    </div>
  );
}
