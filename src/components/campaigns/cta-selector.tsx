"use client";

import { cn } from "@/lib/utils";

const CTA_OPTIONS = [
  "Shop Now",
  "Order Now",
  "Learn More",
  "Get Offer",
  "Sign Up",
  "Book Now",
  "Contact Us",
];

export function CtaSelector({
  selectedCta,
  onSelect,
}: {
  selectedCta: string;
  onSelect: (cta: string) => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Call to action button
        </span>
        <span className="text-[11px] text-subtle-foreground">
          Meta preset
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {CTA_OPTIONS.map((cta) => {
          const isSelected = selectedCta === cta;
          return (
            <button
              key={cta}
              type="button"
              onClick={() => onSelect(cta)}
              className={cn(
                "rounded-lg border px-3 py-1.5 text-xs font-medium transition-all",
                isSelected
                  ? "border-brand-600 bg-brand-50 text-brand-700 shadow-sm"
                  : "border-border bg-surface text-muted-foreground hover:border-border-strong hover:bg-surface-subtle hover:text-foreground",
              )}
            >
              {cta}
            </button>
          );
        })}
      </div>

      <p className="mt-2.5 text-[11.5px] text-muted-foreground">
        Meta only permits their preset button labels. <span className="font-medium text-foreground">Shop Now</span> is the recommended standard to drive direct Shopify purchases.
      </p>
    </div>
  );
}
