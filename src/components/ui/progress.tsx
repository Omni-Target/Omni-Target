import * as React from "react";
import { cn } from "@/lib/utils";
import { clamp } from "@/lib/utils";

const toneMap = {
  brand: "bg-brand-600",
  success: "bg-success-500",
  warning: "bg-warning-500",
  danger: "bg-danger-500",
  ink: "bg-ink",
} as const;

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value: number;
  max?: number;
  tone?: keyof typeof toneMap;
  size?: "sm" | "md" | "lg";
}

export function Progress({
  value,
  max = 100,
  tone = "brand",
  size = "md",
  className,
  ...props
}: ProgressProps) {
  const pct = clamp((value / max) * 100, 0, 100);
  const height = size === "sm" ? "h-1.5" : size === "lg" ? "h-3" : "h-2";
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn(
        "w-full overflow-hidden rounded-full bg-surface-muted",
        height,
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-700 ease-out-expo",
          toneMap[tone],
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
