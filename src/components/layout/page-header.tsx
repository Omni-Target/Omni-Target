import * as React from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
}

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className,
  children,
  ...props
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
      {...props}
    >
      <div className="min-w-0 space-y-1.5">
        {eyebrow && (
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-brand-600">
            {eyebrow}
          </div>
        )}
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground sm:text-[1.75rem]">
          {title}
        </h1>
        {description && (
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
        )}
        {children}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2.5">{actions}</div>
      )}
    </div>
  );
}
