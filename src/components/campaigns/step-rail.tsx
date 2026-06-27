"use client";

import { Check, ImageIcon, PenLine, Eye, FileText, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = [
  { key: "creative", label: "Ad creative", hint: "Upload image or video", Icon: ImageIcon },
  { key: "details", label: "Campaign details", hint: "Product & goal", Icon: PenLine },
  { key: "review", label: "Review copy", hint: "AI-written ad copy", Icon: Eye },
  { key: "brief", label: "Campaign brief", hint: "Targeting & budget", Icon: FileText },
] as const;

export type StepKey = (typeof STEPS)[number]["key"];

export function StepRail({ activeIndex }: { activeIndex: number }) {
  return (
    <div className="lg:sticky lg:top-24">
      <div className="hidden lg:block">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-brand-100 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
          <Sparkles className="size-3.5" />
          AI campaign studio
        </div>
        <ol className="space-y-1">
          {STEPS.map((step, i) => {
            const done = i < activeIndex;
            const active = i === activeIndex;
            return (
              <li key={step.key}>
                <div
                  className={cn(
                    "flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors",
                    active && "bg-surface shadow-xs",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-9 shrink-0 place-items-center rounded-full border text-sm font-semibold transition-colors",
                      done
                        ? "border-brand-600 bg-brand-600 text-white"
                        : active
                          ? "border-brand-300 bg-brand-50 text-brand-700"
                          : "border-border bg-surface text-faint-foreground",
                    )}
                  >
                    {done ? <Check className="size-4" /> : <step.Icon className="size-4" />}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span
                      className={cn(
                        "text-sm font-medium",
                        active ? "text-foreground" : done ? "text-muted-foreground" : "text-faint-foreground",
                      )}
                    >
                      {step.label}
                    </span>
                    <span className="text-xs text-faint-foreground">{step.hint}</span>
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Mobile: compact dots */}
      <div className="flex items-center gap-2 lg:hidden">
        {STEPS.map((step, i) => (
          <div key={step.key} className="flex items-center gap-2">
            <span
              className={cn(
                "size-2.5 rounded-full transition-colors",
                i <= activeIndex ? "bg-brand-600" : "bg-border-strong",
              )}
            />
            {i === activeIndex && (
              <span className="text-sm font-medium text-foreground">{step.label}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
