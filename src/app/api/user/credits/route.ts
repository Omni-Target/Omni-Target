import { auth } from "@clerk/nextjs/server";
import { creditStatusFor } from "@/modules/credits/ledger";
import { reconcileWorkspaceBilling } from "@/modules/credits/shopify-billing";
import { currentWorkspaceFor } from "@/modules/workspaces/current";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
} as const;

/**
 * The signed-in user's credits: the balance and unlimited access of their
 * current workspace, from the ledger. Purchases made directly in Shopify are
 * reconciled first (at most once a minute per workspace).
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE_HEADERS });
  }

  const workspace = await currentWorkspaceFor(userId);
  if (workspace?.status === "active" && workspace.shop_domain) {
    await reconcileWorkspaceBilling(userId, workspace.workspace_id);
  }
  const status = await creditStatusFor(userId, workspace?.workspace_id ?? null);

  return Response.json(
    {
      credits_balance: status.balance,
      shop: status.shopDomain,
      is_unlimited: status.isUnlimited,
      unlimited_until: status.unlimitedUntil,
    },
    { headers: NO_CACHE_HEADERS },
  );
}
