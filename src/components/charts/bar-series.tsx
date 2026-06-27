import * as React from "react";
import { cn } from "@/lib/utils";

export interface BarDatum {
  label: string;
  value: number;
  highlight?: boolean;
}

export interface BarSeriesProps {
  data: BarDatum[];
  height?: number;
  className?: string;
  valueFormatter?: (v: number) => string;
}

/** Lightweight vertical bar chart. */
export function BarSeries({
  data,
  height = 160,
  className,
  valueFormatter,
}: BarSeriesProps) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className={cn("flex items-end gap-2", className)} style={{ height }}>
      {data.map((d, i) => {
        const pct = (d.value / max) * 100;
        return (
          <div key={i} className="group flex min-w-0 flex-1 flex-col items-center gap-2">
            <div className="flex w-full flex-1 items-end">
              <div
                className={cn(
                  "w-full rounded-t-md transition-all duration-500 ease-out-expo",
                  d.highlight
                    ? "bg-gradient-to-t from-brand-600 to-brand-400"
                    : "bg-surface-muted group-hover:bg-brand-200",
                )}
                style={{ height: `${Math.max(pct, 4)}%` }}
                title={valueFormatter ? valueFormatter(d.value) : String(d.value)}
              />
            </div>
            <span className="w-full truncate text-center text-[0.6875rem] font-medium text-faint-foreground">
              {d.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
