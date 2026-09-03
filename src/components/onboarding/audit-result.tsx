import * as React from "react";
import {
  ArrowRight,
  Sparkles,
  TriangleAlert,
  CircleCheck,
  RefreshCw,
  Package,
  ReceiptText,
  Repeat,
  PackageCheck,
  Rocket,
  Gauge,
  Lightbulb,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { DonutGauge } from "@/components/charts/donut-gauge";

export interface AuditResult {
  score: number;
  status: string;
  issues: string[];
  recommendations?: string[];
  positives?: string[];
  breakdown?: {
    products: number;
    orders: number;
    retention: number;
    availability: number;
  };
}

const STATUS_META: Record<
  string,
  { label: string; variant: "success" | "warning" | "danger" | "brand" }
> = {
  healthy: { label: "Store ready", variant: "success" },
  moderate: { label: "Needs some work", variant: "warning" },
  needs_attention: { label: "Needs attention", variant: "danger" },
  syncing: { label: "Sync in progress", variant: "brand" },
  not_connected: { label: "Disconnected", variant: "danger" },
};

// AI verdict — a confident, human read on the score rather than a raw number.
const VERDICT: Record<string, { headline: string; summary: string }> = {
  healthy: {
    headline: "Your store is ready for profitable Meta ads",
    summary:
      "The fundamentals are in place. Below is exactly where to point your budget first — and the moves that will compound your results.",
  },
  moderate: {
    headline: "You're close — a few moves set you up to scale",
    summary:
      "You have real signal to work with. Tighten the areas flagged below and you'll give Meta's algorithm the strongest possible start.",
  },
  needs_attention: {
    headline: "Let's get the fundamentals in place first",
    summary:
      "A little groundwork now saves wasted ad spend later. Here's your prioritized path to becoming ad-ready.",
  },
};

type Tone = "success" | "warning" | "danger";

function metricTone(score: number, max: number): Tone {
  if (score >= max * 0.7) return "success";
  if (score >= max * 0.4) return "warning";
  return "danger";
}

const DIMENSIONS = [
  { key: "products", label: "Product catalog", caption: "Enough to advertise", Icon: Package },
  { key: "orders", label: "Sales signal", caption: "Purchase data for Meta", Icon: ReceiptText },
  { key: "retention", label: "Customer retention", caption: "Repeat-buyer strength", Icon: Repeat },
  { key: "availability", label: "Stock health", caption: "In-stock coverage", Icon: PackageCheck },
] as const;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center sm:text-left">
      <p className="text-lg font-semibold tracking-[-0.01em] text-foreground">
        {value}
      </p>
      <p className="mt-0.5 text-[0.6875rem] font-medium uppercase tracking-wide text-faint-foreground">
        {label}
      </p>
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  caption,
  count,
}: {
  icon: React.ReactNode;
  title: string;
  caption: string;
  count?: number;
}) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-muted text-foreground">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {count !== undefined && count > 0 && (
            <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[0.625rem] font-semibold text-subtle-foreground">
              {count}
            </span>
          )}
        </div>
        <p className="text-xs text-subtle-foreground">{caption}</p>
      </div>
    </div>
  );
}

const INSIGHT_STYLES = {
  success: {
    card: "border-success-100 bg-success-50/60",
    chip: "bg-success-100 text-success-700",
  },
  warning: {
    card: "border-warning-100 bg-warning-50/60",
    chip: "bg-warning-100 text-warning-700",
  },
  brand: {
    card: "border-brand-100 bg-brand-50/60",
    chip: "bg-brand-100 text-brand-700",
  },
} as const;

function InsightSection({
  icon,
  title,
  caption,
  items,
  variant,
  itemIcon,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  caption: string;
  items: string[];
  variant: keyof typeof INSIGHT_STYLES;
  itemIcon: React.ReactNode;
  className?: string;
}) {
  if (!items?.length) return null;
  const styles = INSIGHT_STYLES[variant];
  return (
    <div className={className}>
      <SectionHeader icon={icon} title={title} caption={caption} count={items.length} />
      <div className="space-y-2.5">
        {items.map((item, i) => (
          <div
            key={i}
            className={cn(
              "flex items-start gap-3 rounded-2xl border p-4 text-left",
              styles.card,
            )}
          >
            <span
              className={cn(
                "mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg",
                styles.chip,
              )}
            >
              {itemIcon}
            </span>
            <p className="text-sm leading-relaxed text-foreground/85">{item}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface AuditResultViewProps {
  result: AuditResult;
  onContinue: () => void;
  completing: boolean;
  fromDashboard: boolean;
}

export function AuditResultView({
  result,
  onContinue,
  completing,
  fromDashboard,
}: AuditResultViewProps) {
  const status = STATUS_META[result.status] ?? {
    label: "Needs attention",
    variant: "danger" as const,
  };

  if (result.status === "syncing") {
    return (
      <div className="rounded-2xl border border-border bg-surface p-8 text-center shadow-sm">
        <div className="mx-auto mb-6 grid size-16 place-items-center rounded-2xl bg-brand-50">
          <RefreshCw className="size-7 animate-spin-slow text-brand-600" />
        </div>
        <h2 className="text-xl font-semibold text-foreground">
          Background sync in progress
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          We&apos;re securely pulling your product catalog and recent order
          history to generate your readiness score. This usually takes a few
          moments.
        </p>
        <Button className="mt-6" onClick={onContinue} isLoading={completing}>
          {fromDashboard ? "Return to dashboard" : "Continue to dashboard"}
          {!completing && <ArrowRight className="size-4" />}
        </Button>
      </div>
    );
  }

  const verdict =
    VERDICT[result.status] ??
    (result.score >= 70
      ? VERDICT.healthy
      : result.score >= 40
        ? VERDICT.moderate
        : VERDICT.needs_attention);

  const breakdownItems = result.breakdown
    ? DIMENSIONS.map((d) => ({
        ...d,
        score: result.breakdown![d.key],
        max: 25,
      }))
    : [];

  const areasStrong = breakdownItems.filter((d) => d.score >= d.max * 0.7).length;
  const actionItems =
    (result.issues?.length ?? 0) + (result.recommendations?.length ?? 0);

  return (
    <div className="space-y-6">
      {/* ── Report header ─────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-3xl border border-border bg-surface p-6 shadow-sm animate-fade-in-up sm:p-8">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-16 size-56 rounded-full bg-brand-50 blur-3xl"
        />
        <div className="relative">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-brand-100 bg-brand-50 px-3 py-1 text-[0.6875rem] font-bold uppercase tracking-[0.12em] text-brand-700">
            <Sparkles className="size-3" />
            AI store analysis
            <span className="text-brand-700">·</span>
            <span className="inline-flex items-center gap-1 text-success-600">
              <CircleCheck className="size-3" /> Complete
            </span>
          </div>

          <div className="flex flex-col items-center gap-6 sm:flex-row">
            <DonutGauge value={result.score} sublabel="Readiness" size={140} />
            <div className="text-center sm:text-left">
              <Badge variant={status.variant} dot>
                {status.label}
              </Badge>
              <h2 className="mt-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground sm:text-2xl">
                {verdict.headline}
              </h2>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                {verdict.summary}
              </p>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-3 gap-3 border-t border-border-subtle pt-5">
            <Stat label="Readiness" value={`${result.score}/100`} />
            <Stat label="Strong areas" value={`${areasStrong}/4`} />
            <Stat label="Action items" value={`${actionItems}`} />
          </div>
        </div>
      </div>

      {/* ── Readiness breakdown ───────────────────────────────────────── */}
      {breakdownItems.length > 0 && (
        <div className="animate-fade-in-up-delay-1">
          <SectionHeader
            icon={<Gauge className="size-4" />}
            title="Readiness breakdown"
            caption="How each signal scored"
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {breakdownItems.map((item) => {
              const pct = Math.round((item.score / item.max) * 100);
              const tone = metricTone(item.score, item.max);
              return (
                <div
                  key={item.key}
                  className="rounded-2xl border border-border bg-surface p-4 shadow-xs"
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        "grid size-8 shrink-0 place-items-center rounded-lg",
                        tone === "success" && "bg-success-50 text-success-600",
                        tone === "warning" && "bg-warning-50 text-warning-600",
                        tone === "danger" && "bg-danger-50 text-danger-600",
                      )}
                    >
                      <item.Icon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {item.label}
                      </p>
                      <p className="truncate text-[0.6875rem] text-subtle-foreground">
                        {item.caption}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "text-sm font-semibold",
                        tone === "success" && "text-success-600",
                        tone === "warning" && "text-warning-600",
                        tone === "danger" && "text-danger-600",
                      )}
                    >
                      {pct}%
                    </span>
                  </div>
                  <div className="mt-3">
                    <Progress value={pct} tone={tone} size="sm" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── AI insights ───────────────────────────────────────────────── */}
      <InsightSection
        className="animate-fade-in-up-delay-2"
        icon={<Rocket className="size-4 text-success-600" />}
        title="Start here"
        caption="Your lowest-risk, highest-leverage moves"
        items={result.positives ?? []}
        variant="success"
        itemIcon={<CircleCheck className="size-4" />}
      />
      <InsightSection
        className="animate-fade-in-up-delay-3"
        icon={<TriangleAlert className="size-4 text-warning-600" />}
        title="What to know"
        caption="Watch-outs before you spend"
        items={result.issues ?? []}
        variant="warning"
        itemIcon={<TriangleAlert className="size-3.5" />}
      />
      <InsightSection
        className="animate-fade-in-up-delay-4"
        icon={<Lightbulb className="size-4 text-brand-600" />}
        title="Your AI ad strategy"
        caption="How to deploy your budget for the best start"
        items={result.recommendations ?? []}
        variant="brand"
        itemIcon={<Sparkles className="size-3.5" />}
      />

      <Button
        size="lg"
        className="w-full animate-fade-in-up-delay-4"
        onClick={onContinue}
        isLoading={completing}
      >
        {fromDashboard ? "Return to dashboard" : "Go to dashboard"}
        {!completing && <ArrowRight className="size-4 ml-1" />}
      </Button>
    </div>
  );
}
