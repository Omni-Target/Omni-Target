import * as React from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export interface IntegrationCardProps {
  icon: React.ReactNode;
  name: string;
  description?: React.ReactNode;
  connected?: boolean;
  statusLabel?: string;
  meta?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  accent?: "brand" | "success" | "neutral";
}

const accentMap = {
  brand: "bg-brand-50 text-brand-600",
  success: "bg-success-50 text-success-600",
  neutral: "bg-surface-muted text-subtle-foreground",
};

export function IntegrationCard({
  icon,
  name,
  description,
  connected,
  statusLabel,
  meta,
  action,
  children,
  accent = "brand",
}: IntegrationCardProps) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-6 shadow-xs">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3.5">
          <span
            className={cn(
              "grid size-11 shrink-0 place-items-center rounded-xl [&_svg]:size-5",
              accentMap[accent],
            )}
          >
            {icon}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-semibold text-foreground">{name}</h2>
              {connected !== undefined && (
                <Badge variant={connected ? "success" : "neutral"} size="sm" dot>
                  {statusLabel ?? (connected ? "Connected" : "Not connected")}
                </Badge>
              )}
            </div>
            {description && (
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {description}
              </p>
            )}
            {meta && <div className="mt-2 text-sm text-foreground">{meta}</div>}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
