import * as React from "react";
import { cn } from "@/lib/utils";
import { clamp } from "@/lib/utils";

export interface DonutGaugeProps {
  value: number;
  max?: number;
  size?: number;
  thickness?: number;
  label?: React.ReactNode;
  sublabel?: React.ReactNode;
  tone?: "auto" | "brand" | "success" | "warning" | "danger";
  className?: string;
}

const toneColor: Record<string, string> = {
  brand: "var(--color-brand-600)",
  success: "var(--color-success-500)",
  warning: "var(--color-warning-500)",
  danger: "var(--color-danger-500)",
};

function autoTone(pct: number) {
  if (pct >= 70) return "success";
  if (pct >= 40) return "warning";
  return "danger";
}

export function DonutGauge({
  value,
  max = 100,
  size = 140,
  thickness = 12,
  label,
  sublabel,
  tone = "auto",
  className,
}: DonutGaugeProps) {
  const pct = clamp((value / max) * 100, 0, 100);
  const resolved = tone === "auto" ? autoTone(pct) : tone;
  const color = toneColor[resolved];
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
          stroke="var(--color-surface-muted)"
          strokeWidth={thickness}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 1s cubic-bezier(0.16,1,0.3,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {label ?? (
          <span className="text-3xl font-semibold tracking-[-0.02em] text-foreground">
            {Math.round(value)}
          </span>
        )}
        {sublabel && (
          <span className="mt-0.5 text-xs font-medium text-subtle-foreground">
            {sublabel}
          </span>
        )}
      </div>
    </div>
  );
}
