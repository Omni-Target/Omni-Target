import { auth } from "@clerk/nextjs/server";
import { SignOutButton } from "@clerk/nextjs";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ShoppingBag, Database, LogOut, ShieldAlert } from "lucide-react";
import { getUserIntegration } from "@/lib/db";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { IntegrationCard } from "@/components/settings";
import { SyncButton } from "@/components/SyncButton";
import { DeleteAccountButton } from "@/components/DeleteAccountButton";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SettingsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/login");

  const integration = await getUserIntegration(userId);

  const shopifyConnected =
    !!integration?.shopify_access_token || !!integration?.shopify_store_url;
  const storeDomain =
    integration?.shopify_custom_domain ||
    integration?.shopify_store_url ||
    "your store";

  return (
    <PageContainer width="default" className="space-y-7 pb-16">
      <PageHeader
        title="Settings"
        description="Manage your store connection, data sync, and account."
      />

      <div className="space-y-5">
        {/* Shopify integration */}
        <IntegrationCard
          icon={<ShoppingBag />}
          name="Shopify store"
          connected={shopifyConnected}
          description={
            shopifyConnected
              ? undefined
              : "Connect your Shopify store to unlock store intelligence and campaign briefs."
          }
          meta={
            shopifyConnected ? (
              <span className="font-medium">{integration?.shopify_store_url || "Store connected"}</span>
            ) : undefined
          }
          action={
            shopifyConnected ? undefined : (
              <Button asChild>
                <Link href="/onboarding/connect-shopify?from=dashboard">
                  Connect store
                </Link>
              </Button>
            )
          }
        />

        {/* Store intelligence */}
        <IntegrationCard
          icon={<Database />}
          name="Store intelligence"
          accent="success"
          connected={shopifyConnected}
          statusLabel={shopifyConnected ? "Auto-syncing" : "Idle"}
          description="Your store data is automatically synced from Shopify and used to generate targeting recommendations and campaign briefs."
        >
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface-subtle px-4 py-3">
            <span className="text-sm text-muted-foreground">
              {shopifyConnected
                ? `Auto-syncing from ${storeDomain}`
                : "Connect a store to begin syncing."}
            </span>
            {shopifyConnected && <SyncButton />}
          </div>
        </IntegrationCard>

        {/* Account */}
        <IntegrationCard
          icon={<LogOut />}
          name="Account"
          accent="neutral"
          description="Manage your session or sign out of Omni Target."
          action={
            <SignOutButton>
              <Button variant="outline">
                <LogOut className="size-4" />
                Sign out
              </Button>
            </SignOutButton>
          }
        />

        {/* Danger zone */}
        <div className="rounded-2xl border border-danger-100 bg-danger-50/40 p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3.5">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-danger-50 text-danger-600 [&_svg]:size-5">
                <ShieldAlert />
              </span>
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  Delete account
                </h2>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  Permanently delete your account, all campaign briefs, and
                  disconnect your store. This can&apos;t be undone.
                </p>
              </div>
            </div>
            <div className="shrink-0">
              <DeleteAccountButton />
            </div>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
