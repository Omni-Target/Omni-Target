import { ImageIcon } from "lucide-react";
import type { ProductRow } from "./types";

export function OutOfStockCard({ product }: { product: ProductRow }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface-subtle p-3">
      {product.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={product.image_url}
          alt={product.name ?? "product"}
          className="size-11 shrink-0 rounded-lg object-cover grayscale"
        />
      ) : (
        <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-surface-muted text-faint-foreground">
          <ImageIcon className="size-4" />
        </div>
      )}
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-muted-foreground">{product.name}</p>
        <p className="text-xs font-medium text-danger-600">Out of stock</p>
      </div>
    </div>
  );
}
