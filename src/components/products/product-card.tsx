"use client";

import Image from "next/image";
import { Flame, ArrowRight, ImageIcon, TrendingUp, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ProductRow, ProductLabel } from "./types";

const labelTone: Record<ProductLabel["tone"], string> = {
  success: "text-success-600",
  brand: "text-brand-600",
  muted: "text-muted-foreground",
  faint: "text-faint-foreground",
};

function classificationBadge(c?: string, isTopGateway?: boolean) {
  if (!c || c.toLowerCase() === "insufficient data") return null;
  const isGateway = c.toLowerCase() === "gateway";
  const isConsideration = c.toLowerCase() === "consideration";
  const isHybrid = c.toLowerCase() === "hybrid";

  if (isGateway && isTopGateway) return null; // Shown as #1 Pick for New Buyers on the image overlay

  const variant = isGateway ? "brand" : isConsideration || isHybrid ? "info" : "neutral";
  const label = isGateway
    ? "New Buyer Magnet"
    : isConsideration
      ? "Repeat Favorite"
      : isHybrid
        ? "Proven Seller"
        : c;

  return (
    <Badge variant={variant} size="sm">
      {label}
    </Badge>
  );
}

export function ProductCard({
  product,
  isTopGateway = false,
  label,
  priceLabel,
  revenueLabel,
  onCreateCampaign,
}: {
  product: ProductRow;
  isTopGateway?: boolean;
  label: ProductLabel;
  priceLabel: string;
  revenueLabel: string;
  onCreateCampaign: (product: ProductRow) => void;
}) {
  const decision = product.product_decision;
  const hasEstablishedRole = Boolean(
    product.gateway_classification &&
    product.gateway_classification !== "Insufficient Data" &&
    product.gateway_classification.toLowerCase() !== "unknown" &&
    (product.units_sold ?? 0) >= 3
  );
  const isEmergingGateway = Boolean(
    !hasEstablishedRole && decision?.acquisition_momentum?.is_emerging_gateway
  );
  const coreStockout = decision?.variant_stock_coverage?.core_variant_stockout === true;

  const stockReason = decision?.readiness_reasons?.find((r) =>
    /^\d+ of \d+ variants in stock/.test(r)
  );
  const partialStockText = stockReason
    ? stockReason
        .replace(/\s*\(\d+% of historical demand covered\)\.?/, "")
        .replace("variants in stock.", "in stock")
        .replace("variants in stock", "in stock")
    : null;
  const bridge = decision?.post_entry_bridge;
  const basketMultiplier = decision?.first_order_economics?.basket_multiplier;

  return (
    <div className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md">
      <div className="relative aspect-[4/3] overflow-hidden bg-surface-muted">
        {product.image_url ? (
          <Image
            src={product.image_url}
            alt={product.name ?? "product"}
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 320px"
            className="object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="grid size-full place-items-center text-faint-foreground">
            <ImageIcon className="size-8" />
          </div>
        )}
        <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
          {coreStockout ? (
            <Badge variant="warning" size="sm">
              Key size out
            </Badge>
          ) : partialStockText ? (
            <Badge variant="warning" size="sm">
              {partialStockText}
            </Badge>
          ) : (
            <Badge variant="success" size="sm" dot>
              In stock
            </Badge>
          )}
          {isTopGateway && (
            <Badge variant="brand" size="sm">
              <Sparkles className="size-3" /> #1 Pick for New Buyers
            </Badge>
          )}
          {label.best && !isTopGateway && (
            <Badge variant="warning" size="sm">
              <Flame className="size-3" /> Best seller
            </Badge>
          )}
        </div>
        {decision?.election_score && decision.election_score.total > 0 && hasEstablishedRole && (
          <div className="absolute right-3 top-3 rounded-lg bg-surface/90 px-2 py-0.5 text-[11px] font-semibold text-foreground shadow-xs backdrop-blur-xs">
            {decision.election_score.total}/100
          </div>
        )}
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
          {classificationBadge(product.gateway_classification, isTopGateway)}
          {isEmergingGateway && (
            <Badge variant="brand" size="sm">Rising New-Buyer Pick</Badge>
          )}
          {hasEstablishedRole && decision?.return_evidence?.risk === "review" && (
            <Badge variant="warning" size="sm">High returns</Badge>
          )}
          {!label.best && (
            <span className={cn("text-xs font-medium", labelTone[label.tone])}>
              {label.text}
            </span>
          )}
        </div>

        {(bridge?.top_next_product_name || (basketMultiplier != null && basketMultiplier >= 1.2)) && (
          <div className="mt-2 rounded-lg bg-brand-50/50 px-2.5 py-1.5 text-[11px] leading-snug text-brand-900">
            {bridge?.top_next_product_name ? (
              <span>
                <strong>What they buy next:</strong> Shoppers often come back for {bridge.top_next_product_name}
              </span>
            ) : basketMultiplier != null && basketMultiplier >= 1.2 ? (
              <span>
                <strong>Bigger first carts:</strong> New buyers spend {basketMultiplier}x the item price at checkout
              </span>
            ) : null}
          </div>
        )}

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
