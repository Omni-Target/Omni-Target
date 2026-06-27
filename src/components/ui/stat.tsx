import * as React from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface StatProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  value: React.ReactNode;
  icon?: React.ReactNode;
  hint?: React.ReactNode;
  trend?: { value: string; direction: "up" | "down" | "flat" };
}

export function Stat({
  label,
  value,
  icon,
  hint,
  trend,
  className,
  ...props
}: StatProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)} {...props}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
        {icon && (
          <span className="grid size-8 place-items-center rounded-lg bg-surface-subtle text-subtle-foreground [&_svg]:size-4">
            {icon}
          </span>
        )}
      </div>
      <div className="flex items-end gap-2">
        <span className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
          {value}
        </span>
        {trend && trend.direction !== "flat" && (
          <span
            className={cn(
              "mb-1 inline-flex items-center gap-0.5 text-xs font-semibold",
              trend.direction === "up" ? "text-success-600" : "text-danger-600",
            )}
          >
            {trend.direction === "up" ? (
              <ArrowUpRight className="size-3.5" />
            ) : (
              <ArrowDownRight className="size-3.5" />
            )}
            {trend.value}
          </span>
        )}
      </div>
      {hint && <span className="text-xs text-subtle-foreground">{hint}</span>}
    </div>
  );
}
