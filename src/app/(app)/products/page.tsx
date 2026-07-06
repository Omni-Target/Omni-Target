"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { PackageOpen } from "lucide-react";
import { useStoreData } from "@/hooks/useStoreData";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Section } from "@/components/layout/section";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ProductCard,
  OutOfStockCard,
  ProductsToolbar,
  type SortKey,
  type StockFilter,
  type ProductRow,
  type ProductLabel,
} from "@/components/products";

interface StoreData {
  store?: { currency?: string };
  products?: ProductRow[];
}

function getProductLabel(product: ProductRow, maxSold: number): ProductLabel {
  const sold = product.units_sold || 0;
  if (sold === maxSold && sold > 0) return { text: "Best seller", tone: "success", best: true };
  if (sold >= 3) return { text: `${sold} units sold`, tone: "brand" };
  if (sold > 0) return { text: `${sold} unit${sold > 1 ? "s" : ""} sold`, tone: "muted" };
  return { text: "No sales yet — test with a small budget", tone: "faint" };
}

export default function ProductsPage() {
  const router = useRouter();
  const { data: storeResponse, isLoading: loading } = useStoreData();
  const storeData = (storeResponse?.data ?? null) as StoreData | null;

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("best");
  const [filter, setFilter] = useState<StockFilter>("all");

  // Dead Shopify session — send the user to the dashboard, which owns the
  // reconnect prompt, rather than rendering an empty product list here.
  useEffect(() => {
    if (storeResponse?.reauthRequired) router.replace("/dashboard");
  }, [storeResponse, router]);

  const storeCurrency = storeData?.store?.currency || "USD";

  const formatPrice = (price: number) => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: storeCurrency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(price);
    } catch {
      return `${storeCurrency} ${price.toLocaleString()}`;
    }
  };

  const products = useMemo(() => storeData?.products ?? [], [storeData]);
  const inStockProducts = products.filter((p) => p.in_stock);
  const outOfStockProducts = products.filter((p) => !p.in_stock);
  const maxSold = Math.max(0, ...inStockProducts.map((p) => p.units_sold || 0));

  const matchesSearch = (p: ProductRow) =>
    !search.trim() || (p.name ?? "").toLowerCase().includes(search.trim().toLowerCase());

  const sortedInStock = useMemo(() => {
    const list = inStockProducts.filter(matchesSearch);
    return list.sort((a, b) => {
      switch (sort) {
        case "revenue":
          return (b.revenue ?? 0) - (a.revenue ?? 0);
        case "price_high":
          return (b.price ?? 0) - (a.price ?? 0);
        case "price_low":
          return (a.price ?? 0) - (b.price ?? 0);
        case "name":
          return (a.name ?? "").localeCompare(b.name ?? "");
        case "best":
        default:
          if ((b.units_sold ?? 0) !== (a.units_sold ?? 0))
            return (b.units_sold ?? 0) - (a.units_sold ?? 0);
          return (b.revenue ?? 0) - (a.revenue ?? 0);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inStockProducts, sort, search]);

  const filteredOut = outOfStockProducts.filter(matchesSearch);

  const onCreateCampaign = (product: ProductRow) => {
    sessionStorage.setItem(
      "campaign_draft",
      JSON.stringify({
        product_name: product.name,
        product_description: product.description || product.name,
        // product_price is intentionally excluded — price flows to the AI
        // only as a qualitative tier, never as a raw number in copy.
        product_image: product.image_url || "",
        product_variants:
          product.has_partial_stock && product.in_stock_variant_names
            ? product.in_stock_variant_names.join(", ")
            : "",
        is_new_launch: (product.units_sold ?? 0) < 3,
      }),
    );
    router.push("/campaigns");
  };

  const showIn = filter === "all" || filter === "in";
  const showOut = filter === "all" || filter === "out";
  const isEmpty = !loading && products.length === 0;

  return (
    <PageContainer width="wide" className="space-y-6 pb-24 lg:pb-10">
      <PageHeader
        eyebrow="Store intelligence"
        title="Products"
        description={`${inStockProducts.length} in stock · ${outOfStockProducts.length} out of stock`}
      />

      {!isEmpty && (
        <ProductsToolbar
          search={search}
          onSearch={setSearch}
          sort={sort}
          onSort={setSort}
          filter={filter}
          onFilter={setFilter}
          inCount={inStockProducts.length}
          outCount={outOfStockProducts.length}
        />
      )}

      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-80 rounded-2xl" />
          ))}
        </div>
      ) : isEmpty ? (
        <EmptyState
          icon={<PackageOpen />}
          title="No products found"
          description="Make sure your Shopify store has active products, then sync your store data."
        />
      ) : (
        <div className="space-y-10">
          {showIn && sortedInStock.length > 0 && (
            <Section title="Ready to advertise" description="In-stock products ranked for your campaigns.">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {sortedInStock.map((product) => (
                  <ProductCard
                    key={String(product.id)}
                    product={product}
                    label={getProductLabel(product, maxSold)}
                    priceLabel={formatPrice(product.price ?? 0)}
                    revenueLabel={formatPrice(Math.round(product.revenue ?? 0))}
                    onCreateCampaign={onCreateCampaign}
                  />
                ))}
              </div>
            </Section>
          )}

          {showOut && filteredOut.length > 0 && (
            <Section
              title="Out of stock"
              description="Restock these before advertising — don't run ads on sold-out products."
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {filteredOut.map((product) => (
                  <OutOfStockCard key={String(product.id)} product={product} />
                ))}
              </div>
            </Section>
          )}

          {sortedInStock.length === 0 && filteredOut.length === 0 && (
            <EmptyState
              compact
              icon={<PackageOpen />}
              title="No matching products"
              description="Try a different search or filter."
            />
          )}
        </div>
      )}
    </PageContainer>
  );
}
