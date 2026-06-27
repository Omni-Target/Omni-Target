"use client";

import { Lightbulb, Users, CalendarClock, TrendingUp } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Insight, InsightKind } from "./derive";

const kindMap: Record<
  InsightKind,
  { Icon: React.ElementType; badge: string }
> = {
  premium: { Icon: Lightbulb, badge: "bg-brand-50 text-brand-600" },
  lookalike: { Icon: Users, badge: "bg-info-50 text-info-600" },
  timing: { Icon: CalendarClock, badge: "bg-violet-50 text-accent-600" },
  scale: { Icon: TrendingUp, badge: "bg-success-50 text-success-600" },
};

export function InsightCard({ insight }: { insight: Insight }) {
  const { Icon, badge } = kindMap[insight.kind];
  return (
    <Card interactive className="h-full p-5">
      <div className={cn("grid size-10 place-items-center rounded-xl", badge)}>
        <Icon className="size-5" />
      </div>
      <p className="mt-4 text-sm font-semibold text-foreground">{insight.title}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        {insight.detail}
      </p>
    </Card>
  );
}
