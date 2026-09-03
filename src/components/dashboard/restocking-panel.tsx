"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ProductIntelCard } from "./product-intel-card";
import type { StoreProductLike } from "./derive";

export function RestockingPanel({
  products,
  currency,
  shop,
}: {
  products: StoreProductLike[];
  currency: string;
  shop?: string | null;
}) {
  const gatewayCount = products.filter(
    (p) =>
      p.gateway_classification === "Gateway" ||
      ((p.first_time_buyer_ratio ?? 0) >= 0.7 && (p.units_sold ?? 0) >= 3),
  ).length;

  const [open, setOpen] = React.useState(gatewayCount > 0);
  if (products.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-surface-subtle"
      >
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              Restocking opportunities
            </h3>
            {gatewayCount > 0 ? (
              <Badge variant="brand" size="sm">
                {gatewayCount} Gateway {gatewayCount === 1 ? "Product" : "Products"}
              </Badge>
            ) : (
              <Badge variant="warning" size="sm">
                {products.length} items
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {gatewayCount > 0
              ? "Critical: Restock your top cold traffic acquisition magnets to run Meta ads"
              : "Restock these proven sellers before running ads"}
          </p>
        </div>
        <ChevronDown
          className={cn(
            "size-5 shrink-0 text-subtle-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="grid grid-cols-1 gap-4 border-t border-border-subtle p-5 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <ProductIntelCard
              key={String(p.id)}
              product={p}
              currency={currency}
              variant="restock"
              shop={shop}
            />
          ))}
        </div>
      )}
    </div>
  );
}
