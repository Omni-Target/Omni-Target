"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function ProductsPage() {
  const router = useRouter();
  const [storeData, setStoreData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/store/data", {
      cache: "no-store"
    })
      .then(r => r.json())
      .then(data => {
        setStoreData(data.data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const inStockProducts = storeData?.products?.filter((p: any) => p.in_stock) || [];
  const outOfStockProducts = storeData?.products?.filter((p: any) => !p.in_stock) || [];

  const sortedInStock = [...inStockProducts].sort((a, b) => {
    if (b.units_sold !== a.units_sold) {
      return b.units_sold - a.units_sold;
    }
    return b.revenue - a.revenue;
  });

  const maxSold = Math.max(
    ...sortedInStock.map((p: any) => p.units_sold || 0)
  );

  const getProductLabel = (product: any) => {
    const sold = product.units_sold || 0;
    
    if (sold === maxSold && sold > 0) {
      return {
        text: "🔥 Best seller",
        color: "text-success-400"
      };
    }
    if (sold >= 3) {
      return {
        text: `${sold} units sold`,
        color: "text-brand-400"
      };
    }
    if (sold > 0) {
      return {
        text: `${sold} unit${sold > 1 ? "s" : ""} sold`,
        color: "text-white/40"
      };
    }
    return {
      text: "No sales yet — test with a small budget",
      color: "text-white/30"
    };
  };

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Nav */}
      <nav className="border-b border-border-subtle px-6 h-16 flex items-center justify-between sticky top-0 z-50 bg-surface/80 backdrop-blur-xl">
        <Link href="/dashboard" className="text-sm text-white/40 hover:text-white/70 flex items-center gap-2 transition-colors no-underline">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
          Back to Dashboard
        </Link>
        <span className="text-sm font-semibold text-white/90">
          Your Products
        </span>
        <div />
      </nav>

      <main className="max-w-6xl mx-auto px-4 py-10">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 rounded-full border-2 border-brand-500/20 border-t-brand-500 animate-spin" />
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="mb-8">
              <h1 className="text-2xl font-bold text-white mb-1">
                Your Products
              </h1>
              <p className="text-sm text-white/40">
                {inStockProducts.length} in stock · {outOfStockProducts.length} out of stock
              </p>
            </div>

            {/* In stock section */}
            {inStockProducts.length > 0 && (
              <section className="mb-12">
                <h2 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-4">
                  Ready to Advertise
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {sortedInStock.map((product: any) => (
                    <div key={product.id} className="rounded-xl border border-border-subtle bg-surface p-4 flex flex-col gap-3">
                      
                      {/* Product image */}
                      {product.image_url && (
                        <div className="aspect-square rounded-lg overflow-hidden bg-white/5">
                          <img
                            src={product.image_url}
                            alt={product.name}
                            className="w-full h-full object-cover"
                          />
                        </div>
                      )}

                      {/* Product info */}
                      <div>
                        <h3 className="text-sm font-semibold text-white mb-1">
                          {product.name}
                        </h3>
                        {product.has_partial_stock && (
                          <p className="text-xs text-amber-400 flex items-start gap-1 mt-1 mb-1">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0">
                              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                              <line x1="12" y1="9" x2="12" y2="13"/>
                              <line x1="12" y1="17" x2="12.01" y2="17"/>
                            </svg>
                            <span>{product.in_stock_variant_count} of {product.total_variant_count} variants in stock — brief will only show available sizes</span>
                          </p>
                        )}
                        <p className="text-xs text-white/40 mb-2">
                          ₦{product.price?.toLocaleString()}
                        </p>
                        
                        {/* AI context */}
                        {(() => {
                          const label = getProductLabel(product);
                          return (
                            <p className={`text-xs font-medium mb-3 ${label.color}`}>
                              {label.text}
                            </p>
                          );
                        })()}

                        {product.description && (
                          <p className="text-xs text-white/30 line-clamp-2 mb-3">
                            {product.description}
                          </p>
                        )}
                      </div>

                      {/* CTA */}
                      <button
                        onClick={() => {
                          sessionStorage.setItem("campaign_draft", JSON.stringify({
                            product_name: product.name,
                            product_description: product.description || product.name,
                            product_price: product.price,
                            product_image: product.image_url || "",
                            product_variants: product.has_partial_stock && product.in_stock_variant_names ? product.in_stock_variant_names.join(', ') : ""
                          }));
                          router.push("/campaigns");
                        }}
                        className="mt-auto w-full py-2 px-4 rounded-lg bg-brand-500/10 border border-brand-500/20 text-brand-400 text-xs font-medium text-center hover:bg-brand-500/20 transition-colors cursor-pointer"
                      >
                        Create Ad Campaign →
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Out of stock section */}
            {outOfStockProducts.length > 0 && (
              <section>
                <h2 className="text-xs font-semibold text-white/20 uppercase tracking-wider mb-4">
                  Out of Stock — Don't Advertise These
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                  {outOfStockProducts.map((product: any) => (
                    <div key={product.id} className="rounded-xl border border-border-subtle bg-surface/50 p-3 opacity-50">
                      <div className="flex items-center gap-3">
                        {product.image_url && (
                          <img
                            src={product.image_url}
                            alt={product.name}
                            className="w-10 h-10 rounded-lg object-cover grayscale"
                          />
                        )}
                        <div>
                          <p className="text-xs font-medium text-white/50 truncate max-w-[120px]">
                            {product.name}
                          </p>
                          <p className="text-xs text-error-400">
                            Out of stock
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Empty state */}
            {!loading && inStockProducts.length === 0 && outOfStockProducts.length === 0 && (
              <div className="text-center py-20">
                <p className="text-white/40 text-sm">
                  No products found. Make sure your Shopify store has active products.
                </p>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
