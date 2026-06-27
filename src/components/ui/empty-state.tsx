import * as React from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-3 py-8" : "gap-4 py-14",
        className,
      )}
      {...props}
    >
      {icon && (
        <div className="flex size-14 items-center justify-center rounded-2xl border border-border-subtle bg-surface-subtle text-subtle-foreground [&_svg]:size-6">
          {icon}
        </div>
      )}
      <div className="space-y-1.5">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {description && (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
