import Link from "next/link";
import { Store, ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

export function DashboardSkeleton() {
  return (
    <div className="space-y-8">
      <Skeleton className="h-56 rounded-3xl" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28 rounded-2xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Skeleton className="h-80 rounded-2xl lg:col-span-1" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:col-span-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-36 rounded-2xl" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function ConnectStoreState({
  shop,
  expired = false,
}: {
  shop: string | null;
  /**
   * True when the store was connected but its Shopify session/refresh token is
   * no longer valid (the API returned `reauthRequired`). Forces the reconnect
   * variant even before the `shop` domain has resolved.
   */
  expired?: boolean;
}) {
  const needsReconnect = expired || !!shop;
  return (
    <Card variant="raised" className="px-6 py-16">
      <div className="mx-auto flex max-w-md flex-col items-center text-center">
        <div className="grid size-16 place-items-center rounded-2xl bg-brand-50 text-brand-600">
          <Store className="size-7" />
        </div>
        <h2 className="mt-5 text-xl font-semibold tracking-[-0.01em] text-foreground">
          {needsReconnect
            ? "Reconnect your Shopify store"
            : "Connect your Shopify store"}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {needsReconnect
            ? "Your store connection has expired. Reconnect to keep syncing orders and generating briefs."
            : "We'll read your store data to generate personalised campaign briefs, audience insights, and product recommendations."}
        </p>
        <Button asChild size="lg" className="mt-6">
          <Link
            href={
              needsReconnect
                ? "/api/auth/shopify/connect?from=dashboard"
                : "/onboarding/connect-shopify?from=dashboard"
            }
          >
            {needsReconnect ? "Reconnect store" : "Connect Shopify store"}
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    </Card>
  );
}
