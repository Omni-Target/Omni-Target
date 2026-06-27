"use client";

import { Store, ImagePlus, ArrowRight } from "lucide-react";

export function SelectionStep({
  onUseStoreProduct,
  onUploadCustom,
}: {
  onUseStoreProduct: () => void;
  onUploadCustom: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-3xl flex-col items-center justify-center py-10">
      <div className="mb-10 text-center">
        <h1 className="text-3xl font-semibold tracking-[-0.02em] text-foreground sm:text-4xl">
          How do you want to create your brief?
        </h1>
        <p className="mx-auto mt-3 max-w-lg text-base text-muted-foreground">
          Auto-generate from a product in your store, or start fresh with a custom
          ad creative.
        </p>
      </div>

      <div className="grid w-full grid-cols-1 gap-5 sm:grid-cols-2">
        <button
          onClick={onUseStoreProduct}
          className="group flex flex-col items-start rounded-2xl border border-border bg-surface p-7 text-left shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md"
        >
          <div className="grid size-12 place-items-center rounded-xl bg-brand-50 text-brand-600 transition-transform duration-200 group-hover:scale-105">
            <Store className="size-6" />
          </div>
          <h3 className="mt-5 text-lg font-semibold text-foreground">
            Use a store product
          </h3>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Browse your Shopify catalog and pull product data and images
            automatically.
          </p>
          <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-brand-600">
            Browse products
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </button>

        <button
          onClick={onUploadCustom}
          className="group flex flex-col items-start rounded-2xl border border-border bg-surface p-7 text-left shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md"
        >
          <div className="grid size-12 place-items-center rounded-xl bg-surface-muted text-muted-foreground transition-transform duration-200 group-hover:scale-105">
            <ImagePlus className="size-6" />
          </div>
          <h3 className="mt-5 text-lg font-semibold text-foreground">
            Upload custom creative
          </h3>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Upload your own image or video ad creative and enter the product
            details manually.
          </p>
          <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-brand-600">
            Start fresh
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </button>
      </div>
    </div>
  );
}
