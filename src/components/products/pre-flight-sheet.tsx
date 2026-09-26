"use client";

import React, { useState, useMemo } from "react";
import Image from "next/image";
import {
  Sparkles,
  Zap,
  ArrowRight,
  ImageIcon,
  Check,
  Flame,
  Layers,
  Wand2,
  X,
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
  onCustomizeManual: (product: ProductRow) => void;
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
    shortLabel: "New Drop Launch",
    tagline: "Build inaugural curiosity and launch velocity for fresh arrivals",
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
    preview: "Auto-tuned to your catalog price point and category",
    recommended: true,
  },
  {
    id: "Minimal & Editorial",
    label: "Minimal & Editorial",
    preview: "Pure drape. Tactile texture. Zero distractions.",
  },
  {
    id: "Bold & Direct",
    label: "Bold & Direct",
    preview: "Made to turn heads. Fast. Unapologetic.",
  },
  {
    id: "Warm & Conversational",
    label: "Warm & Conversational",
    preview: "Your new everyday staple just arrived.",
  },
  {
    id: "Premium & Aspirational",
    label: "Premium & Aspirational",
    preview: "Bespoke craftsmanship, cut for timeless longevity.",
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
    product?.gateway_classification?.toLowerCase() === "gateway";
  const isNew = (product?.units_sold ?? 0) < 3;
  const isRepeat =
    product?.gateway_classification?.toLowerCase() === "consideration";

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

  const formattedPrice = product.price
    ? formatCurrency(product.price, currency)
    : "";

  const roleBadge = isGateway ? (
    <Badge variant="brand" size="sm">
      <Sparkles className="size-3" /> Gateway Product
    </Badge>
  ) : isNew ? (
    <Badge variant="warning" size="sm">
      <Flame className="size-3" /> New Launch
    </Badge>
  ) : isRepeat ? (
    <Badge variant="info" size="sm">
      <Layers className="size-3" /> Repeat Favorite
    </Badge>
  ) : null;

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      width="max-w-lg"
      className="p-0 sm:max-w-lg"
    >
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-subtle p-5">
          <div className="flex items-center gap-2">
            <div className="grid size-8 place-items-center rounded-lg bg-brand-50 text-brand-600">
              <Zap className="size-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground">
                Express Campaign Launch
              </h2>
              <p className="text-xs text-muted-foreground">
                1-Click Meta Ad &amp; Budget Generation
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-surface-subtle hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 space-y-6 overflow-y-auto p-5">
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
              <Wand2 className="size-3.5" />
              Pre-Calibrated Strategy
            </div>
            <p className="mt-1 leading-relaxed text-brand-900/90">
              {isGateway
                ? "This product is verified as your Gateway Product — proven to attract cold strangers. We pre-selected an Acquisition campaign to maximize first-time buyers."
                : isNew
                  ? "This is a fresh product with no ad history yet. We pre-selected a New Drop Launch to spark initial discovery and early sales."
                  : "We calibrated this strategy based on your store's sales history, product pricing, and verified catalog claims."}
            </p>
          </div>

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
                    <p className="mt-1 line-clamp-2 text-[0.6875rem] italic text-muted-foreground">
                      &ldquo;{t.preview}&rdquo;
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Sticky Launch Footer */}
        <div className="border-t border-border-subtle bg-surface p-5 space-y-3">
          <Button
            size="xl"
            className="w-full shadow-sm"
            onClick={() =>
              onLaunchExpress({
                product,
                goal: selectedGoal,
                tone: selectedTone,
              })
            }
          >
            <Zap className="size-4" />
            Generate Meta Brief (1 Credit)
            <ArrowRight className="size-4" />
          </Button>

          <div className="text-center">
            <button
              type="button"
              onClick={() => onCustomizeManual(product)}
              className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors underline-offset-4 hover:underline"
            >
              Need to upload a custom video or edit product copy? Customize manually
            </button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}
