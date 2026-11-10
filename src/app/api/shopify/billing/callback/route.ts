import { auth } from "@clerk/nextjs/server";
import { isValidShopDomain } from "@/lib/shopify-oauth";
import { reconcileShopBilling, settleShopifyReturn } from "@/modules/credits/shopify-billing";
import { currentWorkspaceFor } from "@/modules/workspaces/current";
import { createLogger } from "@/platform/logger";

const log = createLogger({ module: "billing-callback" });

const CHARGE_ID_RE = /^(?:gid:\/\/shopify\/(?:AppPurchaseOneTime|AppSubscription)\/)?\d+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The merchant's return from Shopify billing. A one-time purchase is credited
 * to the workspace and purchaser recorded in its purchase intent, after the
 * charge is read back from Shopify with the shop's own credential. Neither the
 * URL nor the signed-in session decides who is credited. A return without an
 * intent (Managed Pricing) is reconciled for the signed-in owner of that shop,
 * where only an unambiguous binding period can attribute it.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chargeId = searchParams.get("charge_id");
  const shop = searchParams.get("shop")?.toLowerCase() ?? null;
  const intentId = searchParams.get("intent");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const fail = (message: string) => Response.redirect(`${appUrl}/dashboard?billing=error&message=${encodeURIComponent(message)}`);
  const success = (credits: number, plan?: string) =>
    Response.redirect(`${appUrl}/dashboard?billing=success&credits=${credits}${plan ? `&plan=${encodeURIComponent(plan)}` : ""}`);

  if (!chargeId || !shop) return fail("Missing charge_id or shop");
  if (!isValidShopDomain(shop) || !CHARGE_ID_RE.test(chargeId) || (intentId && !UUID_RE.test(intentId))) {
    return fail("Invalid billing return");
  }

  try {
    const isSubscription = chargeId.includes("AppSubscription");
    const result = isSubscription ? { outcome: "no_intent" as const } : await settleShopifyReturn(shop, chargeId, intentId);

    switch (result.outcome) {
      case "granted":
      case "duplicate":
        return success(result.credits ?? 0, result.plan?.label);
      case "not_creditable":
        return result.status && result.status !== "ACTIVE"
          ? fail(`Payment was not completed successfully (Status: ${result.status})`)
          : fail("Test charges cannot be used to buy credits");
      case "legacy_claimed":
        return fail("This purchase was already processed");
      case "needs_review":
        return fail("Your purchase was recorded and is waiting for review. Contact support if credits do not appear.");
      case "no_intent":
        return await reconcileForSignedInOwner(shop, fail, success);
      default:
        log.warn("Billing return refused", { outcome: result.outcome });
        return fail("We couldn't verify this purchase with Shopify");
    }
  } catch (error) {
    log.error("Billing return failed", {}, error);
    return fail("Internal server error during callback");
  }
}

async function reconcileForSignedInOwner(
  shop: string,
  fail: (message: string) => Response,
  success: (credits: number) => Response,
): Promise<Response> {
  const { userId } = await auth().catch(() => ({ userId: null as string | null }));
  if (!userId) return fail("Please sign in to confirm this purchase");
  const workspace = await currentWorkspaceFor(userId);
  if (!workspace || workspace.shop_domain !== shop) return fail("This purchase does not belong to your store");
  const summary = await reconcileShopBilling(userId, workspace.workspace_id);
  if (summary.grantedCredits > 0) return success(summary.grantedCredits);
  return fail("Your purchase was recorded. Credits are added once Shopify confirms it.");
}
