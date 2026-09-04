"use client";

import { motion } from "motion/react";
import { Sparkles, Check, Loader2, Lightbulb } from "lucide-react";
import { useState, useEffect } from "react";

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

const OMNI_TIPS = [
  "Up next: You'll review 3 ready-to-use hooks and ad copy tailored for this product, then get your complete targeting and budget plan.",
  "Promoting one hero product at a time gets you sales faster because your ad money isn't spread too thin across too many items.",
  "Different buyers care about different things — some look for premium quality, others want everyday comfort. Testing 3 angles wins you more customers for less money.",
  "Don't worry about picking dozens of detailed interest tags. In modern Meta Ads, your video hook and headline do the targeting for you.",
  "Give new ads at least 3 to 5 days before touching them. Meta needs a few days to find the buyers who love your product.",
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
      setTipIndex((prev) => (prev + 1) % OMNI_TIPS.length);
    }, 4500);

    return () => clearInterval(tipInterval);
  }, []);

  // Calculate approximate progress
  const progressPercent =
    activeStepIndex === 0 ? 25 : activeStepIndex === 1 ? 50 : activeStepIndex === 2 ? 75 : 94;

  return (
    <div className="relative flex min-h-[70vh] flex-1 flex-col items-center justify-center py-8 px-4">
      {/* Soft ambient background glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-xl h-96 bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.09),transparent_70%)] blur-2xl"
      />

      <div className="relative w-full max-w-lg rounded-2xl border border-border/80 bg-card/95 p-6 sm:p-8 shadow-xl shadow-brand-950/5 backdrop-blur-md overflow-hidden">
        {/* Top luminous hairline highlight */}
        <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand-500/50 to-transparent" />

        {/* Top Header with Pulsing Halo */}
        <div className="flex items-start justify-between gap-3 sm:gap-4 mb-6">
          <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
            <div className="relative grid size-10 sm:size-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 border border-brand-200/80 dark:bg-brand-950/40 dark:border-brand-900 shadow-sm mt-0.5 sm:mt-0">
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 7, repeat: Infinity, ease: "linear" }}
                className="absolute -inset-1 rounded-xl border border-brand-400/30 border-dashed"
              />
              <Sparkles className="size-4 sm:size-5 animate-pulse text-brand-600 dark:text-brand-400" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm sm:text-base font-bold text-foreground tracking-tight leading-snug line-clamp-2 break-words">
                {productName ? `Writing ad copy & hooks for ${productName}` : "Writing your ad copy & hooks…"}
              </h2>
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5 truncate">
                <span>{brandName ? `${brandName} · ` : ""}Meta Advantage+ Engine</span>
              </p>
            </div>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="mb-6 space-y-1.5">
          <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span>Step {activeStepIndex + 1} of {GENERATION_STEPS.length}</span>
            </span>
            <span className="tabular-nums font-bold text-brand-600 dark:text-brand-400">
              {progressPercent}%
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-subtle border border-border/40 p-0.5">
            <motion.div
              className="h-full bg-gradient-to-r from-brand-600 via-brand-500 to-indigo-400 rounded-full"
              initial={{ width: "12%" }}
              animate={{ width: `${progressPercent}%` }}
              transition={{ duration: 0.8, ease: "easeOut" }}
            />
          </div>
        </div>

        {/* Dynamic Step Checklist */}
        <div className="space-y-2.5 mb-6">
          {GENERATION_STEPS.map((step, idx) => {
            const isDone = activeStepIndex > idx;
            const isCurrent = activeStepIndex === idx;
            const isPending = activeStepIndex < idx;

            return (
              <motion.div
                key={idx}
                initial={{ opacity: 0.7 }}
                animate={{ opacity: isPending ? 0.45 : 1 }}
                className={`flex items-start gap-3 rounded-xl p-3 text-xs transition-all duration-300 ${
                  isCurrent
                    ? "bg-brand-50/70 border border-brand-200/90 dark:bg-brand-950/40 dark:border-brand-800/80 shadow-xs"
                    : isDone
                    ? "bg-surface-subtle/50 border border-border/40"
                    : "bg-transparent border border-transparent"
                }`}
              >
                <div className="mt-0.5 shrink-0">
                  {isDone ? (
                    <span className="grid size-5 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 shadow-2xs">
                      <Check className="size-3 stroke-[3]" />
                    </span>
                  ) : isCurrent ? (
                    <span className="grid size-5 place-items-center rounded-full bg-brand-500/15 text-brand-600 border border-brand-500/30">
                      <Loader2 className="size-3 animate-spin" />
                    </span>
                  ) : (
                    <span className="grid size-5 place-items-center rounded-full border border-border-strong/80 text-[10px] font-semibold text-muted-foreground bg-surface">
                      {idx + 1}
                    </span>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p
                      className={`font-semibold text-xs sm:text-sm leading-tight transition-colors ${
                        isCurrent
                          ? "text-brand-950 dark:text-brand-100"
                          : isDone
                          ? "text-foreground font-medium"
                          : "text-muted-foreground"
                      }`}
                    >
                      {step.title}
                    </p>
                    {isCurrent && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-semibold text-brand-700 dark:text-brand-300 border border-brand-500/20 shrink-0">
                        <span className="size-1.5 rounded-full bg-brand-600 animate-pulse" />
                        In progress
                      </span>
                    )}
                    {isDone && (
                      <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 shrink-0">
                        Completed
                      </span>
                    )}
                  </div>
                  <p
                    className={`text-[11px] mt-1 leading-snug transition-colors ${
                      isCurrent
                        ? "text-brand-700/90 dark:text-brand-300 font-medium"
                        : "text-muted-foreground/80"
                    }`}
                  >
                    {step.detail}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* High-Contrast Founder Insight Card (replaces muddy brownish box) */}
        <div className="relative rounded-xl border border-[#262347] bg-[#0e0d1a] p-4 text-xs text-[#ededf2] shadow-md overflow-hidden">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-6 -bottom-6 size-24 bg-brand-500/20 rounded-full blur-xl"
          />
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1.5 rounded-md bg-brand-500/25 border border-brand-400/30 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-brand-300">
                <Lightbulb className="size-3 text-amber-400" />
                Omni Tip
              </span>
            </div>
            <span className="text-[10px] text-slate-400 font-medium">Smart Strategy</span>
          </div>
          <div className="min-h-[46px] flex items-center">
            <motion.p
              key={tipIndex}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.3 }}
              className="text-xs leading-relaxed text-slate-200 font-normal"
            >
              {OMNI_TIPS[tipIndex]}
            </motion.p>
          </div>
        </div>
      </div>
    </div>
  );
}
