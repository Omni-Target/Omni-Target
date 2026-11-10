import { z } from "zod";
import { requireUser } from "@/lib/api/require-user";
import { apiError, apiServerError } from "@/lib/api/response";
import { shopifyAdminGraphqlUrl } from "@/lib/shopify-config";
import { getValidShopifyToken } from "@/lib/shopify-token";
import { SHOPIFY_CREDIT_PLANS } from "@/lib/shopify-billing-plans";
import { attachIntentCharge, createPurchaseIntent, CreditError, failPurchaseIntent } from "@/modules/credits/ledger";
import { currentWorkspaceFor } from "@/modules/workspaces/current";
import { createLogger } from "@/platform/logger";

const log = createLogger({ module: "billing-create" });

const BodySchema = z.object({
  shop: z.string().min(1).max(255),
  plan: z.enum(["starter", "growth", "scale"]),
});

const MUTATION = `
  mutation AppPurchaseOneTimeCreate($name: String!, $price: MoneyInput!, $returnUrl: URL!, $test: Boolean) {
    appPurchaseOneTimeCreate(name: $name, price: $price, returnUrl: $returnUrl, test: $test) {
      confirmationUrl
      appPurchaseOneTime { id status }
      userErrors { field message }
    }
  }
`;

/**
 * Starts a one-time Shopify credit purchase for the signed-in user's current
 * workspace. A purchase intent records the workspace, purchaser and plan
 * before Shopify is called; the merchant's return is credited from that
 * intent, never from whoever is signed in when it arrives.
 */
export async function POST(request: Request) {
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;
  const { userId } = authResult;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return apiError("Invalid JSON body", 400);
  }
  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError("Invalid request: shop and a valid plan are required", 400);
  }
  const plan = SHOPIFY_CREDIT_PLANS[parsed.data.plan];

  let intentId: string | null = null;
  try {
    // The workspace and its shop come from the session, never from the client-supplied `shop`.
    const workspace = await currentWorkspaceFor(userId);
    if (!workspace?.shop_domain || workspace.status !== "active") {
      return apiError("Shopify integration not found", 404);
    }
    const token = await getValidShopifyToken(userId, workspace.workspace_id);
    if (token.status !== "ok") {
      return apiError("Shopify integration not found", 404);
    }

    const intent = await createPurchaseIntent({
      workspaceId: workspace.workspace_id,
      actor: userId,
      provider: "shopify",
      planKey: plan.key,
      kind: "one_time",
      credits: plan.credits,
      unlimitedDays: 0,
      amount: Number(plan.price),
      currency: "USD",
    });
    intentId = intent.intentId;

    const returnUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/shopify/billing/callback?shop=${encodeURIComponent(token.shopUrl)}&intent=${intent.intentId}`;
    // Test charges outside production, or when explicitly configured.
    const testMode = process.env.NODE_ENV !== "production" || process.env.SHOPIFY_TEST_BILLING === "true";

    log.info("Starting a Shopify one-time purchase", { workspaceId: workspace.workspace_id, plan: plan.key, testMode });
    const response = await fetch(shopifyAdminGraphqlUrl(token.shopUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token.accessToken },
      body: JSON.stringify({
        query: MUTATION,
        variables: { name: plan.chargeName, price: { amount: plan.price, currencyCode: "USD" }, returnUrl, test: testMode },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      log.error("Shopify refused the purchase", { status: response.status });
      await failPurchaseIntent(intent.intentId, `shopify_http_${response.status}`);
      return apiError("Couldn't start checkout with Shopify. Please try again.", 502);
    }
    const result = await response.json();
    const created = result?.data?.appPurchaseOneTimeCreate;
    if (result?.errors || created?.userErrors?.length || !created?.confirmationUrl || !created?.appPurchaseOneTime?.id) {
      log.error("Shopify did not create the purchase", {
        graphqlErrors: Array.isArray(result?.errors) ? result.errors.length : 0,
        userErrors: created?.userErrors?.length ?? 0,
      });
      await failPurchaseIntent(intent.intentId, "shopify_rejected");
      return apiError("Couldn't start checkout with Shopify. Please try again.", 502);
    }

    await attachIntentCharge(intent.intentId, created.appPurchaseOneTime.id);
    return Response.json({ confirmationUrl: created.confirmationUrl });
  } catch (error) {
    if (intentId) await failPurchaseIntent(intentId, "create_failed").catch(() => {});
    if (error instanceof CreditError && error.code === "workspace_inactive") {
      return apiError("Reconnect your store to buy credits.", 409);
    }
    return apiServerError("billing-create", error);
  }
}
