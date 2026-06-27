import * as React from "react";
import { Check, Sparkles } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { CreditPack } from "@/lib/credit-packs";

export interface CreditPackCardProps {
  pack: CreditPack;
  currency: "USD" | "NGN";
  onBuy: (pack: CreditPack) => void;
}

export function CreditPackCard({ pack, currency, onBuy }: CreditPackCardProps) {
  const price = currency === "USD" ? pack.price_usd : pack.price_ngn;
  const symbol = currency === "USD" ? "$" : "₦";
  const perBrief = pack.credits > 0 ? price / pack.credits : price;
  const featured = pack.highlight;

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-2xl border p-6 transition-all duration-200",
        featured
          ? "border-brand-300 bg-gradient-to-b from-brand-50/70 to-surface shadow-md ring-1 ring-brand-200"
          : "border-border bg-surface shadow-xs hover:border-border-strong hover:shadow-md",
      )}
    >
      {featured && (
        <Badge
          variant="solid"
          className="absolute -top-3 left-6 shadow-sm"
          size="sm"
        >
          <Sparkles className="size-3" />
          Most popular
        </Badge>
      )}

      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-foreground">{pack.name}</h3>
        <span className="text-xs font-medium text-subtle-foreground">
          {pack.credits} {pack.credits === 1 ? "brief" : "briefs"}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{pack.tagline}</p>

      <div className="mt-5 flex items-end gap-1.5">
        <span className="text-[2.5rem] font-semibold leading-none tracking-[-0.03em] text-foreground">
          {formatCurrency(price, symbol)}
        </span>
      </div>
      <p className="mt-1.5 text-xs text-subtle-foreground">
        {formatCurrency(perBrief, symbol)} per brief
        {pack.unlimited_days > 0 ? ` · ${pack.unlimited_days}-day access` : ""}
      </p>

      <Button
        variant={featured ? "primary" : "secondary"}
        className="mt-5 w-full"
        onClick={() => onBuy(pack)}
      >
        Get {pack.name}
      </Button>

      <ul className="mt-6 space-y-2.5 border-t border-border-subtle pt-5">
        {pack.features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm text-muted-foreground">
            <span
              className={cn(
                "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full",
                featured ? "bg-brand-100 text-brand-700" : "bg-success-50 text-success-600",
              )}
            >
              <Check className="size-3" strokeWidth={3} />
            </span>
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}
