"use client";

import { motion } from "motion/react";
import { Sparkles, Check, Loader2, Lightbulb } from "lucide-react";
import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";

interface GeneratingStateProps {
  productName?: string;
  brandName?: string;
}

interface StepItem {
  title: string;
  detail: string;
}

const GENERATION_STEPS: StepItem[] = [
  {
    title: "Analyzing Product Signals & Story",
    detail: "Reading description, price point, and unique craft details…",
  },
  {
    title: "Formulating 3 Proven Creative Angles",
    detail: "Developing Craft & Quality, Effortless Fit, and Scroll-Stopper angles…",
  },
  {
    title: "Drafting Hook-Driven Copy & Headlines",
    detail: "Writing thumb-stopping primary text and high-intent call-to-actions…",
  },
  {
    title: "Assembling Creative Previews",
    detail: "Formatting ad previews and on-screen text for your review…",
  },
];

const FOUNDER_TIPS = [
  "Up next: Review your ad copy and 3 creative hooks. You'll generate the full campaign brief with targeting and budgets right after.",
  "Meta's Advantage+ algorithm performs best when 1 consolidated ad set runs 3 distinct creative angles.",
  "Testing 3 contrasting angles (Craft, Fit, Curiosity) prevents creative fatigue and lowers your cost per purchase.",
  "Single-SKU focus eliminates catalog cannibalization and sends clearer conversion signals to Meta's pixel.",
];

export function GeneratingState({ productName, brandName }: GeneratingStateProps) {
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [tipIndex, setTipIndex] = useState(0);

  // Progressive step advancement
  useEffect(() => {
    const timer1 = setTimeout(() => setActiveStepIndex(1), 2200);
    const timer2 = setTimeout(() => setActiveStepIndex(2), 4800);
    const timer3 = setTimeout(() => setActiveStepIndex(3), 7800);

    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);
    };
  }, []);

  // Cycle founder tips every 4 seconds
  useEffect(() => {
    const tipInterval = setInterval(() => {
      setTipIndex((prev) => (prev + 1) % FOUNDER_TIPS.length);
    }, 4000);

    return () => clearInterval(tipInterval);
  }, []);

  // Calculate approximate progress
  const progressPercent =
    activeStepIndex === 0 ? 25 : activeStepIndex === 1 ? 50 : activeStepIndex === 2 ? 75 : 92;

  return (
    <div className="flex min-h-[70vh] flex-1 flex-col items-center justify-center py-8 px-4">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-card/95 p-6 sm:p-8 shadow-sm backdrop-blur-sm">
        {/* Top Header with Glowing Icon & Badges */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="relative grid size-11 place-items-center rounded-xl bg-brand-50 text-brand-600 border border-brand-100 dark:bg-brand-950/40 dark:border-brand-900">
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 6, repeat: Infinity, ease: "linear" }}
                className="absolute inset-0 rounded-xl border border-brand-300/40 border-dashed"
              />
              <Sparkles className="size-5 animate-pulse" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-semibold text-foreground tracking-tight">
                {productName ? `Writing ad copy & hooks for ${productName}…` : "Writing your ad copy & hooks…"}
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {brandName ? `${brandName} · ` : ""}AI creative engine
              </p>
            </div>
          </div>
          <Badge variant="brand" size="sm" className="shrink-0 text-[10px] uppercase font-bold tracking-wider">
            AI Engine
          </Badge>
        </div>

        {/* Progress Bar */}
        <div className="mb-6 space-y-1.5">
          <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
            <span>Progress</span>
            <span className="tabular-nums font-semibold text-brand-600">{progressPercent}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-subtle">
            <motion.div
              className="h-full bg-gradient-to-r from-brand-500 to-brand-600 rounded-full"
              initial={{ width: "10%" }}
              animate={{ width: `${progressPercent}%` }}
              transition={{ duration: 0.8, ease: "easeOut" }}
            />
          </div>
        </div>

        {/* Dynamic Step Checklist */}
        <div className="space-y-3 mb-6">
          {GENERATION_STEPS.map((step, idx) => {
            const isDone = activeStepIndex > idx;
            const isCurrent = activeStepIndex === idx;
            const isPending = activeStepIndex < idx;

            return (
              <motion.div
                key={idx}
                initial={{ opacity: 0.7 }}
                animate={{ opacity: isPending ? 0.45 : 1 }}
                className={`flex items-start gap-3 rounded-xl p-3 text-xs transition-colors ${
                  isCurrent
                    ? "bg-brand-50/70 border border-brand-200/80 dark:bg-brand-950/30 dark:border-brand-900/60"
                    : isDone
                    ? "bg-surface-subtle/60 border border-transparent"
                    : "bg-transparent border border-transparent"
                }`}
              >
                <div className="mt-0.5 shrink-0">
                  {isDone ? (
                    <span className="grid size-4 place-items-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                      <Check className="size-2.5 stroke-[3]" />
                    </span>
                  ) : isCurrent ? (
                    <span className="grid size-4 place-items-center text-brand-600">
                      <Loader2 className="size-3.5 animate-spin" />
                    </span>
                  ) : (
                    <span className="grid size-4 place-items-center rounded-full border border-border-strong text-[10px] text-muted-foreground">
                      {idx + 1}
                    </span>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <p
                    className={`font-semibold ${
                      isCurrent
                        ? "text-brand-950 dark:text-brand-100"
                        : isDone
                        ? "text-foreground line-through opacity-80"
                        : "text-muted-foreground"
                    }`}
                  >
                    {step.title}
                  </p>
                  <p
                    className={`text-[11px] mt-0.5 leading-snug ${
                      isCurrent ? "text-brand-700/90 dark:text-brand-300" : "text-muted-foreground/80"
                    }`}
                  >
                    {step.detail}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* Founder Tip Ticker */}
        <div className="rounded-xl border border-amber-200/70 bg-amber-50/80 p-3 text-xs text-amber-950 dark:bg-amber-950/30 dark:border-amber-900/60 dark:text-amber-200">
          <div className="flex items-start gap-2">
            <Lightbulb className="size-3.5 shrink-0 text-amber-600 mt-0.5" />
            <motion.p
              key={tipIndex}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.35 }}
              className="text-[11px] leading-relaxed"
            >
              {FOUNDER_TIPS[tipIndex]}
            </motion.p>
          </div>
        </div>
      </div>
    </div>
  );
}
