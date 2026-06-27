"use client";

import { Flame, ArrowRight, ImageIcon, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ProductRow, ProductLabel } from "./types";

const labelTone: Record<ProductLabel["tone"], string> = {
  success: "text-success-600",
  brand: "text-brand-600",
  muted: "text-muted-foreground",
  faint: "text-faint-foreground",
};

function classificationBadge(c?: string) {
  if (!c || c === "Insufficient Data") return null;
  const variant =
    c === "Gateway" ? "brand" : c === "Consideration" ? "warning" : "neutral";
  return (
    <Badge variant={variant} size="sm">
      {c}
    </Badge>
  );
}

export function ProductCard({
  product,
  label,
  priceLabel,
  revenueLabel,
  onCreateCampaign,
}: {
  product: ProductRow;
  label: ProductLabel;
  priceLabel: string;
  revenueLabel: string;
  onCreateCampaign: (product: ProductRow) => void;
}) {
  return (
    <div className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md">
      <div className="relative aspect-[4/3] overflow-hidden bg-surface-muted">
        {product.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.image_url}
            alt={product.name ?? "product"}
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="grid size-full place-items-center text-faint-foreground">
            <ImageIcon className="size-8" />
          </div>
        )}
        <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
          <Badge variant="success" size="sm" dot>
            In stock
          </Badge>
          {label.best && (
            <Badge variant="warning" size="sm">
              <Flame className="size-3" /> Best seller
            </Badge>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {product.product_type && (
              <p className="mb-0.5 truncate text-[0.6875rem] font-medium uppercase tracking-wide text-faint-foreground">
                {product.product_type}
              </p>
            )}
            <h3 className="truncate text-sm font-semibold text-foreground">{product.name}</h3>
          </div>
          <span className="shrink-0 text-sm font-semibold text-foreground">{priceLabel}</span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {classificationBadge(product.gateway_classification)}
          {!label.best && (
            <span className={cn("text-xs font-medium", labelTone[label.tone])}>
              {label.text}
            </span>
          )}
        </div>

        {product.description && (
          <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {product.description}
          </p>
        )}

        <div className="mt-3 flex items-center gap-3 border-t border-border-subtle pt-3 text-xs text-subtle-foreground">
          <span className="inline-flex items-center gap-1">
            <TrendingUp className="size-3.5 text-success-600" />
            {product.units_sold ?? 0} sold
          </span>
          <span className="text-faint-foreground">·</span>
          <span>{revenueLabel} revenue</span>
        </div>

        <button
          onClick={() => onCreateCampaign(product)}
          className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-50 px-4 py-2.5 text-xs font-semibold text-brand-700 transition-colors hover:bg-brand-100"
        >
          Create ad campaign
          <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>
    </div>
  );
}
