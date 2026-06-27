import * as React from "react";
import { cn } from "@/lib/utils";

export interface SectionProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
}

export function Section({
  title,
  description,
  icon,
  actions,
  className,
  children,
  ...props
}: SectionProps) {
  return (
    <section className={cn("space-y-4", className)} {...props}>
      {(title || actions) && (
        <div className="flex items-end justify-between gap-4">
          <div className="flex items-center gap-2.5">
            {icon && (
              <span className="grid size-8 place-items-center rounded-lg bg-surface-subtle text-brand-600 [&_svg]:size-4">
                {icon}
              </span>
            )}
            <div>
              {title && (
                <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">
                  {title}
                </h2>
              )}
              {description && (
                <p className="text-sm text-muted-foreground">{description}</p>
              )}
            </div>
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
