import * as React from "react";
import { cn } from "@/lib/utils";

export interface SeparatorProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
  label?: string;
}

export function Separator({
  className,
  orientation = "horizontal",
  label,
  ...props
}: SeparatorProps) {
  if (label && orientation === "horizontal") {
    return (
      <div
        className={cn("flex items-center gap-3 text-xs text-faint-foreground", className)}
        {...props}
      >
        <span className="h-px flex-1 bg-border-subtle" />
        <span className="font-medium uppercase tracking-wider">{label}</span>
        <span className="h-px flex-1 bg-border-subtle" />
      </div>
    );
  }
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        "shrink-0 bg-border-subtle",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  );
}
