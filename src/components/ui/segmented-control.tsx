"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  label: React.ReactNode;
  value: T;
  icon?: React.ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className,
  ...props
}: SegmentedControlProps<T>) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-1 rounded-xl border border-border-subtle bg-surface-subtle p-1",
        className,
      )}
      {...props}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg font-medium transition-all duration-200 ease-soft outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
              active
                ? "bg-surface text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
              "[&_svg]:size-4",
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
