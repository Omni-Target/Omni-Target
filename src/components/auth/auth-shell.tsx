import * as React from "react";
import { Sparkles, Store, LineChart, Wand2 } from "lucide-react";
import { SplitLayout } from "@/components/layout/split-layout";
import { Wordmark } from "@/components/shared/logo";

const VALUE_PROPS = [
  {
    Icon: Store,
    title: "Shopify intelligence",
    body: "We read your store data — products, orders, buyers — to ground every recommendation.",
  },
  {
    Icon: Wand2,
    title: "AI ad copy in seconds",
    body: "Hook-driven Meta Ad copy and creatives, tuned to your brand and product catalog.",
  },
  {
    Icon: LineChart,
    title: "Budget & targeting briefs",
    body: "Ready-to-launch targeting, budget tiers, and timing — straight into Ads Manager.",
  },
];

function AuthBrandPanel() {
  return (
    <div className="flex h-full flex-col">
      <Wordmark size={30} textClassName="text-white" />

      <div className="mt-auto">
        <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-white/80">
          <Sparkles className="size-3.5 text-brand-300" />
          AI-powered Meta ads for Shopify
        </div>
        <h2 className="mt-5 max-w-sm text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-white">
          Know exactly what to run on Meta — before you spend a dollar.
        </h2>
        <ul className="mt-8 space-y-5">
          {VALUE_PROPS.map(({ Icon, title, body }) => (
            <li key={title} className="flex gap-3.5">
              <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-white/10 text-brand-200">
                <Icon className="size-4.5" />
              </span>
              <div>
                <p className="text-sm font-semibold text-white">{title}</p>
                <p className="mt-0.5 text-sm text-white/55">{body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-auto pt-10 text-xs text-white/35">
        Trusted by 2,400+ merchants · 256-bit encryption · SOC 2 compliant
      </p>
    </div>
  );
}

export function AuthShell({
  children,
  title,
  subtitle,
}: {
  children: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <SplitLayout aside={<AuthBrandPanel />}>
      <div className="mb-8 text-center lg:hidden">
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      </div>
      {children}
    </SplitLayout>
  );
}
