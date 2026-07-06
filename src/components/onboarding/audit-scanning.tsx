import * as React from "react";
import { Check, BrainCircuit, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export const AUDIT_STEPS = [
  "Syncing store data",
  "Analyzing performance metrics",
  "Generating readiness report",
];

// Signals the engine "cross-references" — pure flavour that reinforces the
// impression of a real analysis happening under the hood.
const SIGNALS = [
  "Product catalog",
  "Order velocity",
  "Retention curve",
  "Stock health",
  "Gateway products",
];

export function AuditScanning({ currentStep }: { currentStep: number }) {
  const allDone = currentStep >= AUDIT_STEPS.length;

  return (
    <div className="text-center">
      {/* AI engine eyebrow */}
      <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-brand-100 bg-brand-50 px-3.5 py-1.5">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-500 opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-brand-600" />
        </span>
        <span className="text-[0.6875rem] font-bold uppercase tracking-[0.15em] text-brand-700">
          AI analysis engine
        </span>
      </div>

      {/* Animated core */}
      <div className="relative mx-auto mb-8 size-28">
        <span className="absolute inset-0 animate-pulse-ring rounded-full border border-brand-500/40" />
        <span className="absolute inset-0 rounded-full border-2 border-brand-100" />
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-brand-500 border-r-brand-500/40" />
        <span
          className="absolute inset-2 animate-spin rounded-full border border-transparent border-b-accent-500"
          style={{ animationDuration: "2.4s", animationDirection: "reverse" }}
        />
        <span className="absolute inset-[0.9rem] grid place-items-center overflow-hidden rounded-full bg-gradient-to-br from-brand-600 to-accent-600 shadow-brand">
          <BrainCircuit className="size-8 text-white" />
          {/* scanning sweep */}
          <span className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/25 to-transparent animate-scan-line" />
        </span>
      </div>

      <h2 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
        Analyzing your store
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
        Our engine is cross-referencing your Shopify data against thousands of
        high-performing stores to score your readiness for profitable Meta ads.
      </p>

      {/* Analysis modules */}
      <div className="mx-auto mt-8 max-w-md space-y-2.5 text-left">
        {AUDIT_STEPS.map((label, index) => {
          const done = index < currentStep;
          const active = index === currentStep && !allDone;
          return (
            <div
              key={label}
              className={cn(
                "relative flex items-center gap-3 overflow-hidden rounded-xl border px-4 py-3 transition-all duration-500",
                done && "border-success-100 bg-success-50",
                active && "border-brand-200 bg-brand-50 shadow-xs",
                !done && !active && "border-border-subtle bg-surface-subtle",
              )}
            >
              {active && (
                <span className="pointer-events-none absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/50 to-transparent" />
              )}
              <span className="relative z-10 shrink-0">
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
                  "relative z-10 text-sm font-medium",
                  done
                    ? "text-success-700"
                    : active
                      ? "text-foreground"
                      : "text-faint-foreground",
                )}
              >
                {label}
              </span>
              {active && (
                <span className="relative z-10 ml-auto text-[0.6875rem] font-semibold uppercase tracking-wide text-brand-600">
                  Processing
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Signals being cross-referenced */}
      <div className="mx-auto mt-6 flex max-w-md flex-wrap items-center justify-center gap-1.5">
        {SIGNALS.map((s, i) => (
          <span
            key={s}
            className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface px-2.5 py-1 text-[0.6875rem] font-medium text-subtle-foreground animate-fade-in"
            style={{ animationDelay: `${i * 120}ms`, opacity: 0, animationFillMode: "forwards" }}
          >
            <Sparkles className="size-2.5 text-brand-600" />
            {s}
          </span>
        ))}
      </div>

      <div className="mx-auto mt-8 h-1.5 max-w-md overflow-hidden rounded-full bg-surface-muted">
        <div className="h-full rounded-full bg-gradient-to-r from-brand-600 to-accent-500 animate-progress-fill" />
      </div>

      <p className="mt-3 text-xs text-faint-foreground">
        {allDone ? "Compiling your readiness report…" : "This usually takes a few seconds."}
      </p>
    </div>
  );
}
