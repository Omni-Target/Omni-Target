"use client";

import { Sparkles, Eye, Type, Quote, Copy, Check } from "lucide-react";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { CreativeHook } from "./types";

export const ANGLE_DISPLAY_MAP: Record<string, { label: string; focus: string }> = {
  "Material / Craftsmanship": {
    label: "Craft & Quality",
    focus: "Fabric texture & premium construction",
  },
  "Usability / Transformation": {
    label: "Effortless Fit & Wear",
    focus: "Solves daily dressing hassle & flattering comfort",
  },
  "Contrarian / Curiosity": {
    label: "Why It's Different (Scroll-Stopper)",
    focus: "Defies convention to capture immediate feed attention",
  },
  "Problem / Friction": {
    label: "The Problem Solver",
    focus: "Fixes common frustrations with ordinary options",
  },
  "Identity / Status": {
    label: "Lifestyle & Confidence",
    focus: "Speaks to the buyer's identity and personal aesthetic",
  },
  "Offer / Risk Reversal": {
    label: "Risk-Free Confidence",
    focus: "Removes purchase hesitation and doubt",
  },
};

export function CreativeHooksCard({
  hooks,
  loading,
}: {
  hooks?: CreativeHook[];
  loading?: boolean;
}) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleCopy = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 1500);
  };

  if (loading) {
    return (
      <Card className="p-6">
        <div className="mb-4 flex items-center gap-2">
          <Sparkles className="size-4 text-brand-600" />
          <h3 className="text-sm font-semibold uppercase tracking-widest text-subtle-foreground">
            Advantage+ Creative Hooks
          </h3>
        </div>
        <p className="text-xs italic text-subtle-foreground">
          Generating 3 high-contrast creative angles and visual directions…
        </p>
      </Card>
    );
  }

  if (!hooks || hooks.length === 0) {
    return null;
  }

  return (
    <Card className="p-6">
      <div className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="grid size-6 place-items-center rounded-md bg-brand-50 text-brand-600">
            <Sparkles className="size-3.5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-widest text-subtle-foreground">
              Advantage+ Creative Hooks
            </h3>
            <p className="text-xs text-muted-foreground">
              3 dynamically inferred creative angles tailored for Meta&apos;s AI algorithm
            </p>
          </div>
        </div>
        <Badge variant="brand" size="sm">
          3 Proven Angles
        </Badge>
      </div>

      <div className="space-y-4">
        {hooks.map((hook, idx) => {
          const isCopied = copiedIndex === idx;
          const display = ANGLE_DISPLAY_MAP[hook.angle] || {
            label: hook.angle,
            focus: "Proven Advantage+ creative angle",
          };
          return (
            <div
              key={idx}
              className="rounded-xl border border-border bg-surface-subtle p-4 transition-colors hover:border-border-strong"
            >
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="grid size-5 place-items-center rounded-full bg-brand-600 text-[10px] font-bold text-white shrink-0">
                    {idx + 1}
                  </span>
                  <div className="flex flex-col">
                    <span className="text-xs font-bold text-foreground">
                      {display.label}
                    </span>
                    <span className="text-[10.5px] text-muted-foreground font-normal leading-tight">
                      {display.focus}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    handleCopy(
                      `Visual Cue: ${hook.visual_cue}\nOn-Screen Text: ${hook.on_screen_text}\nPrimary Text Hook: ${hook.primary_text_hook}`,
                      idx
                    )
                  }
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-subtle-foreground hover:bg-surface hover:text-foreground"
                >
                  {isCopied ? (
                    <>
                      <Check className="size-3 text-emerald-600" />
                      <span className="text-emerald-600">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="size-3" />
                      <span>Copy hook</span>
                    </>
                  )}
                </button>
              </div>

              <div className="space-y-2.5 text-xs">
                {/* Visual Cue */}
                <div className="flex items-start gap-2 text-muted-foreground">
                  <Eye className="mt-0.5 size-3.5 shrink-0 text-brand-600" />
                  <div>
                    <span className="font-semibold text-foreground">
                      Visual Cue:{" "}
                    </span>
                    <span>{hook.visual_cue}</span>
                  </div>
                </div>

                {/* On-Screen Text */}
                <div className="flex items-start gap-2 text-muted-foreground">
                  <Type className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                  <div>
                    <span className="font-semibold text-foreground">
                      On-Screen Text:{" "}
                    </span>
                    <span className="inline-block rounded-md bg-amber-500/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                      &ldquo;{hook.on_screen_text}&rdquo;
                    </span>
                  </div>
                </div>

                {/* Opening Hook */}
                <div className="flex items-start gap-2 text-muted-foreground">
                  <Quote className="mt-0.5 size-3.5 shrink-0 text-brand-600" />
                  <div>
                    <span className="font-semibold text-foreground">
                      Primary Text Hook:{" "}
                    </span>
                    <span className="italic text-foreground">
                      &ldquo;{hook.primary_text_hook}&rdquo;
                    </span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
