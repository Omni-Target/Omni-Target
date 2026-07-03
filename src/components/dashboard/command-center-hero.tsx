"use client";

import Link from "next/link";
import {
  Sparkles,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  ArrowRight,
} from "lucide-react";
import { DonutGauge } from "@/components/charts/donut-gauge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AdReadiness } from "./derive";

const readinessMap: Record<
  AdReadiness,
  {
    title: string;
    tone: "success" | "warning" | "danger" | "brand";
    Icon: React.ElementType;
  }
> = {
  ready: { title: "You're good to go", tone: "success", Icon: CheckCircle2 },
  ready_with_warnings: {
    title: "Ready to go",
    tone: "warning",
    Icon: AlertTriangle,
  },
  caution: { title: "Not quite yet", tone: "danger", Icon: XCircle },
  not_ready: {
    title: "Store data out of sync",
    tone: "brand",
    Icon: HelpCircle,
  },
};

const toneText: Record<string, string> = {
  success: "text-success-300",
  warning: "text-warning-300",
  danger: "text-danger-300",
  brand: "text-brand-300",
};

export interface CommandCenterHeroProps {
  storeName: string;
  lastSynced?: string;
  readiness: AdReadiness;
  subtext: string;
  healthScore: number;
  onSync: () => void;
  syncing?: boolean;
}

export function CommandCenterHero({
  storeName,
  lastSynced,
  readiness,
  subtext,
  healthScore,
  onSync,
  syncing,
}: CommandCenterHeroProps) {
  const { title, tone, Icon } = readinessMap[readiness];

  return (
    <div className="relative overflow-hidden rounded-3xl border border-brand-400/20 bg-gradient-ink p-6 text-ink-foreground shadow-lg sm:p-8">
      <div
        aria-hidden
        className="absolute inset-x-8 top-0 h-px bg-linear-to-r from-transparent via-brand-400/60 to-transparent"
      />
      <div
        aria-hidden
        className="absolute -right-20 -top-24 h-72 w-72 rounded-full bg-[radial-gradient(circle,color-mix(in_srgb,var(--color-brand-500)_38%,transparent),transparent_70%)] blur-2xl"
      />
      <div
        aria-hidden
        className="absolute -bottom-28 -left-16 h-64 w-64 rounded-full bg-[radial-gradient(circle,color-mix(in_srgb,var(--color-accent-600)_26%,transparent),transparent_70%)] blur-3xl"
      />
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.12] bg-[radial-gradient(circle_at_15%_20%,var(--color-ink-foreground)_1px,transparent_1px)] bg-size-[24px_24px]"
      />
      <div className="relative flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-xl space-y-4">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand-400/30 bg-brand-500/20 px-3 py-1 text-xs font-medium text-brand-100">
            <Sparkles className="size-3.5 text-brand-300" />
            Intelligence Hub
          </span>
          <div className="space-y-2">
            <div className="flex items-center gap-2.5">
              <Icon className={cn("size-6", toneText[tone])} />
              <h1 className="text-2xl font-semibold tracking-[-0.02em] sm:text-[1.75rem]">
                {title}
              </h1>
            </div>
            <p className="text-sm leading-relaxed text-white/65">{subtext}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <Button asChild size="lg">
              <Link href="/campaigns">
                <Sparkles className="size-4" />
                New campaign brief
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <button
              type="button"
              onClick={onSync}
              disabled={syncing}
              className="inline-flex h-11 items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-4 text-sm font-medium text-white/85 transition-colors hover:bg-white/10 disabled:opacity-60"
            >
              <RefreshCw
                className={cn("size-4", syncing && "animate-spin-slow")}
              />
              {syncing ? "Syncing…" : "Sync store data"}
            </button>
          </div>
          {lastSynced && (
            <p className="text-xs text-white/40">
              {storeName} · Last synced {lastSynced}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-center">
          <DonutGauge
            value={healthScore}
            size={168}
            thickness={14}
            tone="auto"
            label={
              <span className="text-4xl font-semibold tracking-[-0.02em] text-white">
                {healthScore}
              </span>
            }
            sublabel={
              <span className="text-xs font-medium uppercase tracking-wide text-white/50">
                Store health
              </span>
            }
          />
        </div>
      </div>
    </div>
  );
}
