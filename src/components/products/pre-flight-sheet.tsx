"use client";

import React, { useState } from "react";
import Image from "next/image";
import {
  Sparkles,
  Zap,
  ArrowRight,
  ImageIcon,
  Check,
  Flame,
  Layers,
} from "lucide-react";
import { Drawer } from "@/components/ui/drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/currency";
import type { ProductRow } from "./types";

interface PreFlightSheetProps {
  product: ProductRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currency: string;
  onLaunchExpress: (params: {
    product: ProductRow;
    goal: string;
    tone: string;
    useCustomCreative?: boolean;
  }) => void;
  onCustomizeManual: (params: { product: ProductRow; goal: string; tone: string }) => void;
}

const GOAL_OPTIONS = [
  {
    id: "Drive Website Sales",
    label: "Drive Website Sales",
    shortLabel: "Acquire Customers",
    tagline: "High-intent sales copy to convert cold shoppers into buyers",
  },
  {
    id: "Promote a New Collection",
    label: "Promote a New Collection",
    shortLabel: "New Arrival Launch",
    tagline: "Build curiosity and launch velocity for fresh arrivals",
  },
  {
    id: "Retarget Past Visitors",
    label: "Retarget Past Visitors",
    shortLabel: "Retargeting",
    tagline: "Address hesitation and re-engage shoppers who know your brand",
  },
  {
    id: "Grow Brand Awareness",
    label: "Grow Brand Awareness",
    shortLabel: "Brand Story",
    tagline: "Spotlight design signatures, craft, and distinctive brand ethos",
  },
] as const;

const TONE_OPTIONS = [
  {
    id: "Let AI decide",
    label: "Let AI Decide",
    description: "Auto-selects the optimal tone based on your price point and store data.",
    recommended: true,
  },
  {
    id: "Warm & Conversational",
    label: "Warm & Conversational",
    description: "Talks like a trusted friend recommending their personal daily favorite.",
  },
  {
    id: "Bold & Direct",
    label: "Bold & Direct",
    description: "Punchy, fast-paced, and straight to the point with zero fluff.",
  },
  {
    id: "Minimal & Editorial",
    label: "Minimal & Editorial",
    description: "Understated and calm. Lets the product design speak for itself.",
  },
  {
    id: "Premium & Aspirational",
    label: "Premium & Aspirational",
    description: "Refined and high-status. Focuses on craft and lasting prestige.",
  },
] as const;

export function PreFlightSheet({
  product,
  open,
  onOpenChange,
  currency,
  onLaunchExpress,
  onCustomizeManual,
}: PreFlightSheetProps) {
  // Determine intelligent defaults based on product status
  const isGateway =
    product?.gateway_classification?.toLowerCase() === "gateway" ||
    product?.product_decision?.role === "Gateway";
  const isRepeat =
    product?.gateway_classification?.toLowerCase() === "consideration" ||
    product?.product_decision?.role === "Consideration";
  const isHybrid =
    product?.gateway_classification?.toLowerCase() === "hybrid" ||
    product?.product_decision?.role === "Hybrid";
  const isNew = (product?.units_sold ?? 0) < 3;

  const defaultGoal = isGateway
    ? "Drive Website Sales"
    : isNew
      ? "Promote a New Collection"
      : isRepeat
        ? "Retarget Past Visitors"
        : "Drive Website Sales";

  const [selectedGoal, setSelectedGoal] = useState<string>(defaultGoal);
  const [selectedTone, setSelectedTone] = useState<string>("Let AI decide");

  // Reset to intelligent default whenever product changes
  React.useEffect(() => {
    if (product) {
      const g = isGateway
        ? "Drive Website Sales"
        : isNew
          ? "Promote a New Collection"
          : isRepeat
            ? "Retarget Past Visitors"
            : "Drive Website Sales";
      setSelectedGoal(g);
      setSelectedTone("Let AI decide");
    }
  }, [product, isGateway, isNew, isRepeat]);

  if (!product) return null;
  const decision = product.product_decision;
  const returns = decision?.return_evidence;

  const formattedPrice = product.price
    ? formatCurrency(product.price, currency)
    : "";

  const roleBadge = isGateway ? (
    <Badge variant="brand" size="sm">
      <Sparkles className="size-3" /> New Buyer Magnet
    </Badge>
  ) : isNew ? (
    <Badge variant="warning" size="sm">
      <Flame className="size-3" /> New Launch
    </Badge>
  ) : isRepeat ? (
    <Badge variant="info" size="sm">
      <Layers className="size-3" /> Repeat Favorite
    </Badge>
  ) : isHybrid ? (
    <Badge variant="outline" size="sm">
      <Zap className="size-3" /> Proven Seller
    </Badge>
  ) : null;

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      title="Generate Campaign Brief"
      description="Tailored ad copy, audience targeting, and budget plan"
      footer={
        <div className="w-full space-y-3">
          <Button
            size="xl"
            className="w-full shadow-sm"
            onClick={() => onLaunchExpress({ product, goal: selectedGoal, tone: selectedTone })}
          >
            <Zap className="size-4" />
            Generate Meta Brief (1 Credit)
            <ArrowRight className="size-4" />
          </Button>
          <div className="text-center">
            <button
              type="button"
              onClick={() => onCustomizeManual({ product, goal: selectedGoal, tone: selectedTone })}
              className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors underline-offset-4 hover:underline"
            >
              Need to upload a custom video or edit product copy? Customize manually
            </button>
          </div>
        </div>
      }
      width="max-w-lg"
      className="p-0 sm:max-w-lg"
    >
      <div className="space-y-6">
          {/* Product Snapshot */}
          <div className="flex gap-4 rounded-xl border border-border bg-surface-subtle p-3.5">
            <div className="relative size-20 shrink-0 overflow-hidden rounded-lg bg-surface-muted ring-1 ring-border-subtle">
              {product.image_url ? (
                <Image
                  src={product.image_url}
                  alt={product.name ?? "Product"}
                  fill
                  className="object-cover"
                />
              ) : (
                <div className="grid size-full place-items-center text-faint-foreground">
                  <ImageIcon className="size-6" />
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                {roleBadge}
                {product.units_sold !== undefined && (
                  <span className="text-[0.6875rem] font-medium text-muted-foreground">
                    {product.units_sold} sold
                  </span>
                )}
              </div>
              <h3 className="truncate text-sm font-semibold text-foreground">
                {product.name}
              </h3>
              {formattedPrice && (
                <p className="mt-0.5 text-xs font-semibold text-foreground">
                  {formattedPrice}
                </p>
              )}
              {product.in_stock_variant_names &&
                product.in_stock_variant_names.length > 0 && (
                  <p className="mt-1 truncate text-[0.6875rem] text-muted-foreground">
                    Variants:{" "}
                    {product.in_stock_variant_names.slice(0, 3).join(", ")}
                  </p>
                )}
            </div>
          </div>

          {/* AI Intelligence Note */}
          <div className="rounded-xl border border-brand-100 bg-brand-50/50 p-3.5 text-xs text-brand-950">
            <div className="flex items-center gap-1.5 font-semibold text-brand-800">
              <Sparkles className="size-3.5 text-brand-600" />
              Recommended Campaign Setup
            </div>
            <p className="mt-1 leading-relaxed text-brand-900/90">
              {isGateway
                ? "New shoppers buy this piece more than anything else in your store — making it your highest-signal product to test for cold customer acquisition."
                : isRepeat
                  ? "Shoppers love coming back for this piece. Ideal for retargeting past visitors and turning one-time buyers into loyal repeat customers."
                  : isNew
                    ? "Fresh drop with no sales history yet. Perfect for building early buzz, testing audience demand, and getting your first orders rolling in."
                    : isHybrid
                      ? `Dependable seller${product.units_sold ? ` (${product.units_sold} sold)` : ""} with steady demand across new and returning shoppers. A solid choice to scale consistent order volume.`
                      : "Matched to your product price point and store demand to help you get the most out of your test budget."}
            </p>
          </div>

          {decision && (
            <div className="space-y-2 rounded-xl border border-border p-3.5 text-xs text-muted-foreground">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-foreground">Why this piece works</p>
                {decision.election_score && decision.election_score.total > 0 && (
                  <Badge variant="brand" size="sm">
                    Score {decision.election_score.total}/100
                  </Badge>
                )}
              </div>
              <p>
                <span className="font-medium text-foreground">New-buyer appeal:</span>{" "}
                {decision.role === "Gateway"
                  ? `Chosen by ${Math.round((decision.first_order_reach ?? 0) * 100)}% of your new customers (${decision.first_order_count} of ${decision.identified_first_orders} first-time orders).`
                  : decision.role === "Consideration"
                    ? `Bought in ${Math.round((decision.later_order_reach ?? 0) * 100)}% of repeat orders (${decision.later_order_count} of ${decision.identified_later_orders} returning orders).`
                    : decision.role === "Hybrid"
                      ? `Steady demand across ${decision.first_order_count} first-time orders and ${decision.later_order_count} repeat orders.`
                      : decision.role_reason}
              </p>
              {decision.first_order_economics?.basket_multiplier != null &&
                decision.first_order_economics.basket_multiplier >= 1.15 && (
                  <p>
                    <span className="font-medium text-foreground">Bigger first carts:</span> New buyers who start here check out with an average cart of{" "}
                    <span className="font-medium text-foreground">
                      {decision.first_order_economics.avg_first_order_value != null
                        ? formatCurrency(Math.round(decision.first_order_economics.avg_first_order_value), currency)
                        : `${decision.first_order_economics.basket_multiplier}x item price`}
                    </span>{" "}
                    ({decision.first_order_economics.basket_multiplier}x item price
                    {decision.first_order_economics.multi_item_first_order_rate
                      ? ` — ${Math.round(decision.first_order_economics.multi_item_first_order_rate * 100)}% add extra items`
                      : ""}).
                  </p>
                )}
              {(decision.follow_up_60d.repeat_rate !== null || decision.post_entry_bridge?.top_next_product_name) && (
                <p>
                  <span className="font-medium text-foreground">What they buy next:</span>{" "}
                  {decision.follow_up_60d.buyers_with_another_order > 0 ? (
                    <>
                      {decision.follow_up_60d.buyers_with_another_order} of {decision.follow_up_60d.eligible_first_order_buyers} new buyers ({Math.round((decision.follow_up_60d.repeat_rate ?? 0) * 100)}%) came back for another order within 60 days
                      {decision.post_entry_bridge?.top_next_product_name ? (
                        <> — most often for <span className="font-medium text-foreground">{decision.post_entry_bridge.top_next_product_name}</span></>
                      ) : null}
                      .
                    </>
                  ) : (
                    <>No 60-day repeat orders recorded from first-time buyers yet.</>
                  )}
                </p>
              )}
              {decision.high_value_entry && (() => {
                const vipRatio = Math.round((decision.high_value_entry.high_value_first_buyers_with_product / decision.high_value_entry.high_value_buyers) * 100);
                return (
                  <p>
                    <span className="font-medium text-foreground">VIP customer magnet:</span> {decision.high_value_entry.high_value_first_buyers_with_product} of your top {decision.high_value_entry.high_value_buyers} spenders ({vipRatio}%) bought this on their very first order.
                  </p>
                );
              })()}
              {decision.variant_stock_coverage?.core_variant_stockout &&
              decision.variant_stock_coverage.stocked_out_core_variants.length > 0 ? (
                <p className="font-medium text-amber-800">
                  <span className="font-semibold">Heads up before spending:</span> Best-selling option ({decision.variant_stock_coverage.stocked_out_core_variants.join(", ")}) is currently sold out — only {Math.round((decision.variant_stock_coverage.demand_weighted_stock_share ?? 0) * 100)}% of historical demand is in stock.
                </p>
              ) : (
                <p className={returns?.risk === "review" ? "font-medium text-amber-800" : undefined}>
                  <span className="font-medium text-foreground">Stock & returns:</span>{" "}
                  {decision.variant_stock_coverage && decision.variant_stock_coverage.unweighted_stock_share < 1
                    ? `${Math.round((decision.variant_stock_coverage.demand_weighted_stock_share ?? 0) * 100)}% of popular options in stock`
                    : "All options in stock"}
                  {returns?.processed_return_rate != null
                    ? returns.processed_return_units === 0
                      ? ` · 0 returns across ${returns.eligible_units} orders.`
                      : ` · ${returns.processed_return_units} of ${returns.eligible_units} orders returned (${Math.round(returns.processed_return_rate * 100)}%).`
                    : "."}
                </p>
              )}
            </div>
          )}

          {/* Campaign Objective Selector */}
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-faint-foreground">
              Campaign Goal
            </label>
            <div className="space-y-2">
              {GOAL_OPTIONS.map((g) => {
                const selected = selectedGoal === g.id;
                const isRecommended = defaultGoal === g.id;
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setSelectedGoal(g.id)}
                    className={cn(
                      "flex w-full items-start justify-between rounded-xl border p-3 text-left transition-all",
                      selected
                        ? "border-brand-600 bg-brand-50/40 ring-1 ring-brand-500/20"
                        : "border-border bg-surface hover:border-border-strong hover:bg-surface-subtle",
                    )}
                  >
                    <div className="min-w-0 pr-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-foreground">
                          {g.label}
                        </span>
                        {isRecommended && (
                          <Badge variant="brand" size="sm">
                            Recommended
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-muted-foreground">
                        {g.tagline}
                      </p>
                    </div>
                    <div
                      className={cn(
                        "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border transition-colors",
                        selected
                          ? "border-brand-600 bg-brand-600 text-white"
                          : "border-border",
                      )}
                    >
                      {selected && <Check className="size-2.5" />}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Tone Preference Selector */}
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-faint-foreground">
              Brand Voice &amp; Tone
            </label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {TONE_OPTIONS.map((t) => {
                const selected = selectedTone === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelectedTone(t.id)}
                    className={cn(
                      "rounded-xl border p-2.5 text-left transition-all",
                      selected
                        ? "border-brand-600 bg-brand-50/40 ring-1 ring-brand-500/20"
                        : "border-border bg-surface hover:border-border-strong hover:bg-surface-subtle",
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-foreground">
                        {t.label}
                      </span>
                      {selected && (
                        <Check className="size-3 text-brand-600" />
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-[0.6875rem] leading-relaxed text-muted-foreground">
                      {t.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
      </div>
    </Drawer>
  );
}
