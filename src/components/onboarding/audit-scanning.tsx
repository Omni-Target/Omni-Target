import * as React from "react";
import { Check, Radar } from "lucide-react";
import { cn } from "@/lib/utils";

export const AUDIT_STEPS = [
  "Syncing store data",
  "Analyzing performance metrics",
  "Generating readiness report",
];

export function AuditScanning({ currentStep }: { currentStep: number }) {
  return (
    <div className="text-center">
      {/* Scanner */}
      <div className="relative mx-auto mb-8 size-24">
        <span className="absolute inset-0 rounded-full border-2 border-brand-100" />
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-brand-500" />
        <span
          className="absolute inset-2 animate-spin rounded-full border border-transparent border-t-accent-500"
          style={{ animationDuration: "1.6s", animationDirection: "reverse" }}
        />
        <span className="absolute inset-4 grid place-items-center rounded-full bg-brand-50">
          <Radar className="size-7 text-brand-600" />
        </span>
        <span className="absolute inset-0 animate-pulse-ring rounded-full border border-brand-300/50" />
      </div>

      <h2 className="text-xl font-semibold tracking-[-0.01em] text-foreground">
        Running your store audit
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
        We&apos;re analyzing your Shopify store to see how ready it is for
        high-converting Meta ads.
      </p>

      {/* Steps */}
      <div className="mx-auto mt-8 max-w-sm space-y-2.5 text-left">
        {AUDIT_STEPS.map((label, index) => {
          const done = index < currentStep;
          const active = index === currentStep;
          return (
            <div
              key={label}
              className={cn(
                "flex items-center gap-3 rounded-xl border px-4 py-3 transition-all duration-500",
                done && "border-success-100 bg-success-50",
                active && "border-brand-200 bg-brand-50",
                !done && !active && "border-border-subtle bg-surface-subtle",
              )}
            >
              <span className="shrink-0">
                {done ? (
                  <span className="grid size-5 place-items-center rounded-full bg-success-500 text-white">
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                ) : active ? (
                  <span className="block size-5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
                ) : (
                  <span className="block size-5 rounded-full border border-border-strong" />
                )}
              </span>
              <span
                className={cn(
                  "text-sm font-medium",
                  done ? "text-success-700" : active ? "text-foreground" : "text-faint-foreground",
                )}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mx-auto mt-8 h-1.5 max-w-sm overflow-hidden rounded-full bg-surface-muted">
        <div className="h-full rounded-full bg-gradient-to-r from-brand-600 to-accent-500 animate-progress-fill" />
      </div>
    </div>
  );
}
