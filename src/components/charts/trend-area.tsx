import * as React from "react";
import { cn } from "@/lib/utils";

export interface TrendPoint {
  label?: string;
  value: number;
}

export interface TrendAreaProps {
  data: TrendPoint[];
  height?: number;
  className?: string;
  tone?: string;
  showAxis?: boolean;
}

/** Smooth area+line chart drawn in pure SVG (responsive width). */
export function TrendArea({
  data,
  height = 180,
  className,
  tone = "text-brand-500",
  showAxis = true,
}: TrendAreaProps) {
  const gid = React.useId();
  if (data.length < 2) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-xl border border-dashed border-border text-xs text-faint-foreground",
          className,
        )}
        style={{ height }}
      >
        Not enough data yet
      </div>
    );
  }

  const W = 600;
  const H = 200;
  const padY = 16;
  const values = data.map((d) => d.value);
  const max = Math.max(...values);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = W / (data.length - 1);

  const pts = data.map((d, i) => {
    const x = i * stepX;
    const y = padY + (1 - (d.value - min) / range) * (H - padY * 2);
    return [x, y] as const;
  });

  // Catmull-Rom -> cubic bezier smoothing
  const path = pts.reduce((acc, p, i, arr) => {
    if (i === 0) return `M${p[0]},${p[1]}`;
    const prev = arr[i - 1];
    const cx = (prev[0] + p[0]) / 2;
    return `${acc} C${cx},${prev[1]} ${cx},${p[1]} ${p[0]},${p[1]}`;
  }, "");
  const area = `${path} L${W},${H} L0,${H} Z`;

  return (
    <div className={cn("relative w-full", className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        className={cn(tone)}
        aria-hidden
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {showAxis &&
          [0.25, 0.5, 0.75].map((f) => (
            <line
              key={f}
              x1="0"
              x2={W}
              y1={H * f}
              y2={H * f}
              stroke="currentColor"
              strokeOpacity="0.07"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        <path d={area} fill={`url(#${gid})`} />
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx={pts[pts.length - 1][0]}
          cy={pts[pts.length - 1][1]}
          r="4"
          fill="currentColor"
        />
      </svg>
      {showAxis && data.some((d) => d.label) && (
        <div className="mt-2 flex justify-between text-[0.6875rem] font-medium text-faint-foreground">
          {data.map((d, i) =>
            d.label && (i === 0 || i === data.length - 1 || i === Math.floor(data.length / 2)) ? (
              <span key={i}>{d.label}</span>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
