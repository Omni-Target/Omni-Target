"use client";

import Image from "next/image";
import { ImageIcon, ArrowRight, Sparkles, ExternalLink, Zap } from "lucide-react";
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
  shop?: string | null;
}

function classificationBadge(c?: string) {
  if (!c) return null;
  let label = c;
  let variant: "brand" | "warning" | "info" | "neutral" = "neutral";
  if (c.toLowerCase() === "gateway") {
    label = "Gateway";
    variant = "brand";
  } else if (c.toLowerCase() === "consideration") {
    label = "Repeat Favorite";
    variant = "warning";
  } else if (c.toLowerCase() === "hybrid") {
    label = "Proven Seller";
    variant = "info";
  } else if (c.toLowerCase() === "insufficient data") {
    label = "New Arrival";
    variant = "neutral";
  }
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
  shop,
}: ProductIntelCardProps) {
  const isOutOfStock = !product.in_stock;
  const isNewLaunch = variant === "new-launch";
  const isGateway =
    product.gateway_classification?.toLowerCase() === "gateway" ||
    (isOutOfStock &&
      (product.first_time_buyer_ratio ?? 0) >= 0.7 &&
      (product.units_sold ?? 0) >= 3);

  const narrative = deriveProductNarrative(product);
  const footerAmount = isNewLaunch ? product.price : product.revenue;
  const shopifyAdminUrl =
    shop && product.id ? `https://${shop}/admin/products/${product.id}` : null;

  return (
    <div
      className={cn(
        "group flex flex-col rounded-2xl border bg-surface p-4 shadow-xs transition-all duration-200",
        isOutOfStock && isGateway
          ? "border-amber-300 bg-amber-50/15 shadow-xs hover:border-amber-400 hover:shadow-md"
          : isOutOfStock
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
            {isOutOfStock ? (
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
            {isOutOfStock && isGateway ? (
              <Badge variant="warning" size="sm">
                <Zap className="size-3" />
                Restock Priority
              </Badge>
            ) : null}
            {!isNewLaunch && classificationBadge(product.gateway_classification || (isGateway ? "Gateway" : undefined))}
          </div>
        </div>
      </div>

      {isNewLaunch ? (
        <p className="mt-3 rounded-lg bg-success-50 px-3 py-2 text-xs italic text-success-700">
          New product — create an ad brief to introduce it to shoppers
        </p>
      ) : isOutOfStock && isGateway ? (
        <div className="mt-3 rounded-lg border border-amber-200/80 bg-amber-50/80 p-2.5 text-xs text-amber-900">
          <p className="font-semibold flex items-center gap-1.5 text-amber-950">
            <Sparkles className="size-3.5 text-amber-600" />
            Gateway Hero · Restock to Run Ads
          </p>
          <p className="mt-0.5 text-amber-800">
            {product.first_time_buyer_ratio
              ? `${Math.round(product.first_time_buyer_ratio * 100)}% of buyers were first-time customers.`
              : "Proven driver of new store customers."}{" "}
            Restock this style on Shopify to start attracting new shoppers again.
          </p>
        </div>
      ) : !isOutOfStock && (narrative.subtext || narrative.primaryMetric) ? (
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
        {isOutOfStock ? (
          shopifyAdminUrl ? (
            <a
              href={shopifyAdminUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-amber-700 transition-colors hover:text-amber-800"
            >
              Restock on Shopify
              <ExternalLink className="size-3" />
            </a>
          ) : (
            <span className="font-medium text-warning-600">Restock on Shopify</span>
          )
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
