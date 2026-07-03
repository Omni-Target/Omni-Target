import * as React from "react";
import { Check, Store, Gauge, ShieldCheck } from "lucide-react";
import { SplitLayout } from "@/components/layout/split-layout";
import { Wordmark } from "@/components/shared/logo";
import { cn } from "@/lib/utils";

const STEPS = [
  {
    n: 1,
    label: "Connect your store",
    desc: "Link your Shopify backend via encrypted, read-only credentials.",
    Icon: Store,
  },
  {
    n: 2,
    label: "Catalog & Margin mapping",
    desc: "Our engine maps your inventory data to define your optimal targeting and creative paths.",
    Icon: Gauge,
  },
];

function ProgressRail({ currentStep }: { currentStep: 1 | 2 }) {
  return (
    <ol className="relative space-y-7">
      {STEPS.map((step, i) => {
        const done = step.n < currentStep;
        const active = step.n === currentStep;
        return (
          <li key={step.n} className="relative flex gap-4">
            {i < STEPS.length - 1 && (
              <span
                className={cn(
                  "absolute left-4.75 top-11 h-[calc(100%-1rem)] w-px",
                  done ? "bg-brand-400/60" : "bg-white/15",
                )}
              />
            )}
            <span
              className={cn(
                "relative z-10 grid size-10 shrink-0 place-items-center rounded-xl border transition-colors",
                done && "border-brand-400/40 bg-brand-500/25 text-white",
                active && "border-white/30 bg-white/10 text-white",
                !done && !active && "border-white/10 bg-white/5 text-white/40",
              )}
            >
              {done ? (
                <Check className="size-5" strokeWidth={2.5} />
              ) : (
                <step.Icon className="size-5" />
              )}
            </span>
            <div className="pt-1">
              <p
                className={cn(
                  "text-sm font-semibold",
                  active || done ? "text-white" : "text-white/45",
                )}
              >
                {step.label}
              </p>
              <p className="mt-0.5 text-xs text-white/45">{step.desc}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export interface OnboardingShellProps {
  currentStep: 1 | 2;
  children: React.ReactNode;
  contentClassName?: string;
}

export function OnboardingShell({
  currentStep,
  children,
  contentClassName = "max-w-xl",
}: OnboardingShellProps) {
  return (
    <SplitLayout
      contentClassName={contentClassName}
      aside={
        <div className="flex h-full flex-col">
          <Wordmark size={30} textClassName="text-white" />
          <div className="mt-auto">
            <h2 className="max-w-sm text-[1.625rem] font-semibold leading-tight tracking-[-0.02em] text-white">
              Let&apos;s build your first pre-spend blueprint.
            </h2>
            <p className="mt-3 max-w-xs text-sm text-white/55">
              Two quick steps. Just connect your storefront and our engine will
              isolate exactly what your data says to launch next.
            </p>
            <div className="mt-10">
              <ProgressRail currentStep={currentStep} />
            </div>
          </div>
          <p className="mt-auto flex items-center gap-2 pt-10 text-xs text-white/35">
            <ShieldCheck className="size-3.5" />
            Read-only access · 256-bit encryption · SOC 2 compliant
          </p>
        </div>
      }
    >
      {children}
    </SplitLayout>
  );
}
