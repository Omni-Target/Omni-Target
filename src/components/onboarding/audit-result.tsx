import * as React from "react";
import {
  ArrowRight,
  Sparkles,
  TriangleAlert,
  CircleCheck,
  RefreshCw,
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

const STATUS_META: Record<string, { label: string; variant: "success" | "warning" | "danger" | "brand" }> = {
  healthy: { label: "Store ready", variant: "success" },
  moderate: { label: "Needs some work", variant: "warning" },
  syncing: { label: "Sync in progress", variant: "brand" },
  not_connected: { label: "Disconnected", variant: "danger" },
};

function metricTone(score: number, max: number): "success" | "warning" | "danger" {
  if (score >= max * 0.7) return "success";
  if (score >= max * 0.4) return "warning";
  return "danger";
}

function ListBlock({
  title,
  icon,
  items,
  variant,
}: {
  title: string;
  icon: React.ReactNode;
  items: string[];
  variant: "success" | "warning" | "brand";
}) {
  if (!items?.length) return null;
  const styles = {
    success: "border-success-100 bg-success-50 text-success-700",
    warning: "border-warning-100 bg-warning-50 text-warning-700",
    brand: "border-brand-100 bg-brand-50 text-brand-700",
  }[variant];
  return (
    <div className="text-left">
      <p className="mb-2.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-subtle-foreground">
        {icon}
        {title}
      </p>
      <div className="space-y-2">
        {items.map((item, i) => (
          <div
            key={i}
            className={cn("flex items-start gap-2.5 rounded-xl border px-4 py-2.5 text-sm", styles)}
          >
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-current" />
            <span className="leading-relaxed text-foreground/80">{item}</span>
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

  const breakdownItems = result.breakdown
    ? [
        { label: "Products", score: result.breakdown.products, max: 25 },
        { label: "Orders", score: result.breakdown.orders, max: 25 },
        { label: "Retention", score: result.breakdown.retention, max: 25 },
        { label: "Availability", score: result.breakdown.availability, max: 25 },
      ]
    : [];

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border bg-surface p-7 shadow-sm">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-6">
          <DonutGauge value={result.score} sublabel="Score" size={132} />
          <div className="text-center sm:text-left">
            <Badge variant={status.variant} dot>
              {status.label}
            </Badge>
            <h2 className="mt-2.5 text-xl font-semibold tracking-[-0.01em] text-foreground">
              Store readiness audit
            </h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Here&apos;s how prepared your store is to run profitable Meta ads
              right now.
            </p>
          </div>
        </div>

        {breakdownItems.length > 0 && (
          <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {breakdownItems.map((item) => {
              const pct = Math.round((item.score / item.max) * 100);
              const tone = metricTone(item.score, item.max);
              return (
                <div
                  key={item.label}
                  className="rounded-xl border border-border-subtle bg-surface-subtle px-4 py-3"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium text-foreground">
                      {item.label}
                    </span>
                    <span
                      className={cn(
                        "text-xs font-semibold",
                        tone === "success" && "text-success-600",
                        tone === "warning" && "text-warning-600",
                        tone === "danger" && "text-danger-600",
                      )}
                    >
                      {pct}%
                    </span>
                  </div>
                  <Progress value={pct} tone={tone} size="sm" />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-5">
        <ListBlock
          title="Start here"
          icon={<CircleCheck className="size-3.5 text-success-600" />}
          items={result.positives ?? []}
          variant="success"
        />
        <ListBlock
          title="What to know"
          icon={<TriangleAlert className="size-3.5 text-warning-600" />}
          items={result.issues ?? []}
          variant="warning"
        />
        <ListBlock
          title="Your ad strategy"
          icon={<Sparkles className="size-3.5 text-brand-600" />}
          items={result.recommendations ?? []}
          variant="brand"
        />
      </div>

      <Button
        size="lg"
        className="w-full"
        onClick={onContinue}
        isLoading={completing}
      >
        {fromDashboard ? "Return to dashboard" : "Continue to dashboard"}
        {!completing && <ArrowRight className="size-4" />}
      </Button>
    </div>
  );
}
