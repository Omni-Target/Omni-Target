"use client";

import { cn } from "@/lib/utils";

const CTA_OPTIONS = [
  "Shop Now",
  "Learn More",
  "Order Now",
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
      <span className="text-xs font-medium uppercase tracking-wider text-faint-foreground">
        Call to action button
      </span>
      <div className="mt-2 flex flex-wrap gap-2">
        {CTA_OPTIONS.map((cta) => (
          <button
            key={cta}
            type="button"
            onClick={() => onSelect(cta)}
            className={cn(
              "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
              selectedCta === cta
                ? "border-brand-300 bg-brand-50 text-brand-700"
                : "border-border bg-surface text-muted-foreground hover:border-border-strong hover:text-foreground",
            )}
          >
            {cta}
          </button>
        ))}
      </div>
    </div>
  );
}
