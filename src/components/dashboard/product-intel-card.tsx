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
  isTopGateway?: boolean;
  onCreateBrief?: (product: StoreProductLike, isNewLaunch: boolean) => void;
  shop?: string | null;
}

function roleBadge(
  role?: string,
  isTopGateway?: boolean,
  isEmergingGateway?: boolean,
  isOutOfStock?: boolean,
) {
  const normalized = (role || "").toLowerCase();
  if (isOutOfStock && normalized === "gateway") {
    return (
      <Badge variant="warning" size="sm">
        <Zap className="size-3" />
        Restock Priority
      </Badge>
    );
  }
  if (isTopGateway && !isOutOfStock) {
    return (
      <Badge variant="brand" size="sm">
        <Sparkles className="size-3" />
        #1 Pick for New Buyers
      </Badge>
    );
  }
  if (normalized === "gateway") {
    return (
      <Badge variant="brand" size="sm">
        New Buyer Magnet
      </Badge>
    );
  }
  if (isEmergingGateway) {
    return (
      <Badge variant="brand" size="sm">
        Rising New-Buyer Pick
      </Badge>
    );
  }
  if (normalized === "consideration") {
    return (
      <Badge variant="info" size="sm">
        Repeat Favorite
      </Badge>
    );
  }
  if (normalized === "hybrid") {
    return (
      <Badge variant="info" size="sm">
        All-Around Seller
      </Badge>
    );
  }
  return null;
}

export function ProductIntelCard({
  product,
  currency,
  variant = "intelligence",
  isTopGateway = false,
  onCreateBrief,
  shop,
}: ProductIntelCardProps) {
  const isOutOfStock = !product.in_stock;
  const isNewLaunch = variant === "new-launch";
  const isGateway =
    product.gateway_classification?.toLowerCase() === "gateway";
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
  const outVariants = decision?.variant_stock_coverage?.stocked_out_core_variants ?? [];
  const demandShare = decision?.variant_stock_coverage?.demand_weighted_stock_share;
  const hasPartialStock =
    product.in_stock_variant_count !== undefined &&
    product.total_variant_count !== undefined &&
    product.total_variant_count > 1 &&
    product.in_stock_variant_count < product.total_variant_count;

  const firstPct =
    decision && decision.identified_first_orders > 0
      ? Math.round((decision.first_order_count / decision.identified_first_orders) * 100)
      : 0;
  const multiItemPct =
    decision?.first_order_economics?.multi_item_first_order_rate != null
      ? Math.round(decision.first_order_economics.multi_item_first_order_rate * 100)
      : null;
  const avgCart = decision?.first_order_economics?.avg_first_order_value;
  const basketMult = decision?.first_order_economics?.basket_multiplier;
  const bridge = decision?.post_entry_bridge;
  const returns = decision?.return_evidence;

  const narrative = deriveProductNarrative(product);
  const footerAmount = isNewLaunch ? product.price : product.revenue;
  const shopifyAdminUrl =
    shop && product.id ? `https://${shop}/admin/products/${product.id}` : null;

  // Single, clear stock badge (never shows both "In stock" and "3 of 4 in stock")
  const stockBadge = isOutOfStock ? (
    <Badge variant="danger" size="sm" dot>
      Out of stock
    </Badge>
  ) : isNewLaunch ? (
    <Badge variant="success" size="sm">
      <Sparkles className="size-3" />
      New launch
    </Badge>
  ) : coreStockout ? (
    <Badge variant="warning" size="sm">
      {outVariants.length > 0
        ? `Option ${outVariants.slice(0, 2).join(", ")} sold out`
        : "Core options sold out"}
    </Badge>
  ) : returns?.risk === "review" ? (
    <Badge variant="warning" size="sm">
      High returns
    </Badge>
  ) : hasPartialStock && (demandShare == null || demandShare < 0.9) ? (
    <Badge variant="warning" size="sm">
      {product.in_stock_variant_count} of {product.total_variant_count} in stock
    </Badge>
  ) : (
    <Badge variant="success" size="sm" dot>
      In stock
    </Badge>
  );

  // Friendly stock & quality check line inside the drawer
  const launchCheckText = !decision
    ? ""
    : decision.test_readiness === "hold" || isOutOfStock
      ? "Sold out right now — restock before running ads."
      : coreStockout
        ? `Hold off on ads until ${outVariants.length > 0 ? `option ${outVariants.join(", ")} is` : "popular options are"} restocked — ${outVariants.length === 1 ? "it drives" : "they drive"} ${Math.round((1 - (demandShare ?? 0)) * 100)}% of sales for this piece.`
        : returns?.risk === "review"
          ? `${returns.processed_return_units} of ${returns.eligible_units} orders (${Math.round((returns.processed_return_rate ?? 0) * 100)}%) were returned. Check sizing or fit before running ads.`
          : [
              hasPartialStock
                ? `${product.in_stock_variant_count} of ${product.total_variant_count} options in stock${demandShare != null ? ` (covers ${Math.round(demandShare * 100)}% of buyer demand)` : ""}`
                : "All options in stock",
              returns?.processed_return_rate != null && returns.processed_return_units === 0
                ? `0 returns across ${returns.eligible_units} orders`
                : returns?.processed_return_rate != null
                  ? `${Math.round(returns.processed_return_rate * 100)}% return rate (${returns.processed_return_units} of ${returns.eligible_units})`
                  : null,
            ]
              .filter(Boolean)
              .join(" · ") + ".";

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
          <div className="flex items-start justify-between gap-2">
            <p className="truncate text-sm font-semibold text-foreground">
              {product.name}
            </p>
            {!isNewLaunch &&
              !isOutOfStock &&
              decision?.election_score &&
              decision.election_score.total > 0 && (
                <span
                  title="Cold-Acquisition Score out of 100"
                  className="shrink-0 rounded-full border border-border-subtle bg-surface-subtle px-2 py-0.5 text-[11px] font-semibold text-muted-foreground"
                >
                  {decision.election_score.total}/100
                </span>
              )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {stockBadge}
            {!isNewLaunch &&
              roleBadge(
                product.gateway_classification,
                isTopGateway,
                isEmergingGateway,
                isOutOfStock,
              )}
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
            Restock Priority · Proven New-Buyer Magnet
          </p>
          <p className="mt-0.5 text-amber-800">
            {decision
              ? `${firstPct}% of your new customers (${decision.first_order_count} of ${decision.identified_first_orders}) bought this in their very first order.`
              : "This product is a proven favorite for first-time shoppers."}{" "}
            Restock before running ads.
          </p>
        </div>
      ) : !isOutOfStock && (narrative.subtext || narrative.primaryMetric) ? (
        <div className="mt-3 rounded-lg bg-surface-subtle px-3 py-2.5">
          {narrative.primaryMetric && (
            <p className="text-xs font-semibold text-foreground">
              {narrative.primaryMetric}
            </p>
          )}
          {narrative.subtext && (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {narrative.subtext}
            </p>
          )}
        </div>
      ) : null}

      {decision && !isNewLaunch && (
        <details className="mt-3 rounded-lg border border-border-subtle px-3 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-semibold text-foreground">
            Why we picked this product
          </summary>
          <ul className="mt-2.5 space-y-2 leading-relaxed">
            <li>
              <strong className="text-foreground">New-buyer appeal:</strong>{" "}
              {decision.role === "Gateway"
                ? `Brought in ${decision.first_order_count} of your ${decision.identified_first_orders} new customers (${firstPct}%) on their very first order (vs. ${decision.later_order_count} repeat orders).`
                : decision.role === "Consideration"
                  ? `Bought in ${decision.later_order_count} repeat orders by returning shoppers who already know your brand.`
                  : decision.role === "Hybrid"
                    ? `Bought in ${decision.first_order_count} first-time orders and ${decision.later_order_count} repeat orders.`
                    : `Bought in ${decision.first_order_count} first-time order${decision.first_order_count === 1 ? "" : "s"} so far.`}
            </li>

            {basketMult != null && basketMult >= 1.15 && avgCart != null && (
              <li>
                <strong className="text-foreground">Bigger first carts:</strong>{" "}
                {multiItemPct != null && multiItemPct >= 50
                  ? `${multiItemPct}% of new buyers add extra items at checkout, spending an average of ${formatCurrency(Math.round(avgCart), currency)} (${basketMult}x the item price).`
                  : `First-time buyers spend an average of ${formatCurrency(Math.round(avgCart), currency)} at checkout (${basketMult}x the item price).`}
              </li>
            )}

            {bridge?.top_next_product_name ? (
              <li className="rounded-md bg-brand-50/70 px-2.5 py-1.5 text-brand-800">
                <strong>What they buy next:</strong> When first-time buyers come back
                {bridge.median_days_to_second_order != null
                  ? ` (~${Math.round(bridge.median_days_to_second_order)} days later)`
                  : ""}
                , they most often buy <strong>{bridge.top_next_product_name}</strong> ({bridge.top_next_product_buyers} of {bridge.repeat_buyers_from_entry} repeat buyers).
              </li>
            ) : decision.follow_up_60d.repeat_rate !== null &&
              decision.follow_up_60d.buyers_with_another_order > 0 ? (
              <li className="rounded-md bg-brand-50/70 px-2.5 py-1.5 text-brand-800">
                <strong>Repeat loyalty:</strong> {decision.follow_up_60d.buyers_with_another_order} of{" "}
                {decision.follow_up_60d.eligible_first_order_buyers} first-time buyers (
                {Math.round(decision.follow_up_60d.repeat_rate * 100)}%) came back for another order within 60 days.
              </li>
            ) : null}

            <li className={coreStockout || returns?.risk === "review" ? "font-medium text-amber-800" : undefined}>
              <strong className="text-foreground">
                {coreStockout || returns?.risk === "review" ? "Heads up before spending:" : "Stock & quality:"}
              </strong>{" "}
              {launchCheckText}
            </li>
          </ul>

          {decision.election_score && (
            <details className="mt-2 border-t border-border-subtle pt-2">
              <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                See score breakdown ({decision.election_score.total}/100)
              </summary>
              <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 rounded bg-surface-subtle p-2 text-[11px] text-muted-foreground">
                <span>• New-buyer pull: {decision.election_score.breakdown.entry_lift}/35</span>
                <span>• Repeat loyalty: {decision.election_score.breakdown.retention_ltv}/25</span>
                <span>• Recent momentum: {decision.election_score.breakdown.momentum}/15</span>
                <span>• Cart size: {decision.election_score.breakdown.basket_economics}/15</span>
                <span className="col-span-2">• Stock &amp; return health: {decision.election_score.breakdown.operational_readiness}/10</span>
              </div>
            </details>
          )}
        </details>
      )}

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
