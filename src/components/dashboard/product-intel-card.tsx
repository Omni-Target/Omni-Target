"use client";

import Image from "next/image";
import { ImageIcon, ArrowRight, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/currency";
import {
  deriveProductNarrative,
  type StoreProductLike,
} from "./derive";

type Variant = "intelligence" | "new-launch" | "restock";

export interface ProductIntelCardProps {
  product: StoreProductLike;
  currency: string;
  variant?: Variant;
  onCreateBrief?: (product: StoreProductLike, isNewLaunch: boolean) => void;
}

function classificationBadge(c?: string) {
  if (!c) return null;
  const label = c === "Insufficient Data" ? "New Launch Brief" : c;
  const variant =
    c === "Gateway"
      ? "brand"
      : c === "Consideration"
        ? "warning"
        : c === "Insufficient Data"
          ? "info"
          : "neutral";
  return (
    <Badge variant={variant} size="sm">
      {label}
    </Badge>
  );
}

export function ProductIntelCard({
  product,
  currency,
  variant = "intelligence",
  onCreateBrief,
}: ProductIntelCardProps) {
  const isRestock = variant === "restock";
  const isNewLaunch = variant === "new-launch";
  const narrative = deriveProductNarrative(product);
  const footerAmount = isNewLaunch ? product.price : product.revenue;

  return (
    <div
      className={cn(
        "group flex flex-col rounded-2xl border bg-surface p-4 shadow-xs transition-all duration-200",
        isRestock
          ? "border-border-subtle opacity-80 grayscale hover:opacity-100 hover:grayscale-0"
          : "border-border hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md",
      )}
    >
      <div className="flex items-start gap-3">
        {product.image_url ? (
          <Image
            src={product.image_url}
            alt={product.name ?? "product"}
            width={56}
            height={56}
            className="size-14 shrink-0 rounded-xl object-cover ring-1 ring-border-subtle"
          />
        ) : (
          <div className="grid size-14 shrink-0 place-items-center rounded-xl bg-surface-muted text-faint-foreground">
            <ImageIcon className="size-5" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {product.name}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {isRestock ? (
              <Badge variant="danger" size="sm" dot>
                Out of stock
              </Badge>
            ) : isNewLaunch ? (
              <Badge variant="success" size="sm">
                <Sparkles className="size-3" />
                New launch
              </Badge>
            ) : (
              <Badge variant="success" size="sm" dot>
                In stock
              </Badge>
            )}
            {!isNewLaunch && classificationBadge(product.gateway_classification)}
          </div>
        </div>
      </div>

      {isNewLaunch ? (
        <p className="mt-3 rounded-lg bg-success-50 px-3 py-2 text-xs italic text-success-700">
          New product — launch brief available before the first sale
        </p>
      ) : !isRestock && (narrative.subtext || narrative.primaryMetric) ? (
        <div className="mt-3 rounded-lg bg-surface-subtle px-3 py-2">
          {narrative.subtext && (
            <p className="text-xs italic text-muted-foreground">{narrative.subtext}</p>
          )}
          {narrative.primaryMetric && (
            <p className="mt-1 text-xs font-semibold text-foreground">
              {narrative.primaryMetric}
            </p>
          )}
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border-subtle pt-3 text-xs">
        <span className="text-subtle-foreground">
          {product.units_sold ?? 0} sold ·{" "}
          {formatCurrency(Math.round(footerAmount ?? 0), currency)}
        </span>
        {isRestock ? (
          <span className="font-medium text-warning-600">Restock</span>
        ) : isNewLaunch || product.should_advertise ? (
          <button
            type="button"
            onClick={() => onCreateBrief?.(product, isNewLaunch)}
            className="inline-flex items-center gap-1 font-semibold text-brand-600 transition-colors hover:text-brand-700"
          >
            {isNewLaunch ? "Launch brief" : "Create brief"}
            <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </button>
        ) : (
          <span className="text-faint-foreground">Low conversion</span>
        )}
      </div>
    </div>
  );
}
