import { auth } from "@clerk/nextjs/server";
import { getIntegrationByUser, addCreditsToUser } from "@/lib/billing-db";
import { claimPayment, releasePayment, createPayment } from "@/lib/db";
import { shopifyAdminGraphqlUrl } from "@/lib/shopify-config";
import { isValidShopDomain, verifyBillingReturn } from "@/lib/shopify-oauth";
import { isCreditableCharge, planForShopifyCharge } from "@/lib/shopify-billing-plans";

const CHARGE_ID_RE = /^(?:gid:\/\/shopify\/(?:AppPurchaseOneTime|AppSubscription)\/)?\d+$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chargeId = searchParams.get("charge_id");
  const shop = searchParams.get("shop");
  const fail = (message: string) =>
    Response.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard?billing=error&message=${encodeURIComponent(message)}`);

  if (!chargeId || !shop) return fail("Missing charge_id or shop");
  if (!isValidShopDomain(shop) || !CHARGE_ID_RE.test(chargeId)) return fail("Invalid billing return");

  // A return URL we issued carries a signed uid, which survives an expired
  // session. Managed Pricing returns carry no uid and need a live session.
  // Anything else is not trusted; a real charge is still credited later by
  // reconciliation, which reads it from Shopify directly.
  const claimedUid = searchParams.get("uid");
  const session = await auth().catch(() => ({ userId: null }));
  if (claimedUid && !verifyBillingReturn(claimedUid, shop, searchParams.get("sig"))) {
    console.warn("[billing-callback] rejected a return with an invalid signature");
    return fail("Invalid billing return");
  }
  const uid = claimedUid || session.userId;
  if (!uid) return fail("Please sign in to confirm this purchase");

  try {
    // 1. The charge is read with this account's own token, on its own shop.
    const integration = await getIntegrationByUser(uid);
    if (!integration || !integration.access_token) {
      console.error(`Integration or token not found for user: ${uid}`);
      return fail("Shopify integration not found");
    }
    if ((integration.shop_domain || "").toLowerCase() !== shop.toLowerCase()) {
      console.warn("[billing-callback] rejected a return for a shop this account does not own");
      return fail("This purchase does not belong to your store");
    }

    // 2. Query the charge from Shopify GraphQL API (check both AppPurchaseOneTime
    //    and AppSubscription so App Store Managed Pricing plans work seamlessly)
    const numericId = chargeId.replace(/^gid:\/\/shopify\/[^/]+\//, "");
    const oneTimeGid = chargeId.startsWith("gid://")
      ? chargeId
      : `gid://shopify/AppPurchaseOneTime/${numericId}`;
    const subscriptionGid = `gid://shopify/AppSubscription/${numericId}`;

    const query = `
      query GetAppBillingCharge($oneTimeId: ID!, $subId: ID!) {
        oneTime: node(id: $oneTimeId) {
          ... on AppPurchaseOneTime {
            id
            name
            status
            test
            price {
              amount
              currencyCode
            }
          }
        }
        subscription: node(id: $subId) {
          ... on AppSubscription {
            id
            name
            status
            test
          }
        }
      }
    `;

    const shopifyUrl = shopifyAdminGraphqlUrl(integration.shop_domain || shop);
    const response = await fetch(shopifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": integration.access_token,
      },
      body: JSON.stringify({
        query,
        variables: { oneTimeId: oneTimeGid, subId: subscriptionGid },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to fetch charge details from Shopify: ${response.status} ${response.statusText}`, errorText);
      return Response.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?billing=error&message=Failed+to+verify+charge+with+Shopify`
      );
    }

    const result = await response.json();
    if (result.errors && !result.data?.oneTime && !result.data?.subscription) {
      console.error("Shopify GraphQL errors while fetching charge:", result.errors);
      return Response.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?billing=error&message=Shopify+GraphQL+error`
      );
    }

    const chargeNode =
      (result.data?.oneTime?.id ? result.data.oneTime : null) ||
      (result.data?.subscription?.id ? result.data.subscription : null);
    const globalId = chargeNode?.id || oneTimeGid;
    if (!chargeNode) {
      console.error(`No charge node found for ID: ${oneTimeGid} or ${subscriptionGid}`);
      return Response.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?billing=error&message=Charge+not+found`
      );
    }

    // 3. Verify charge is ACTIVE
    if (chargeNode.status !== "ACTIVE") {
      console.warn(`Charge status is not ACTIVE. Current status: ${chargeNode.status}`);
      return Response.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?billing=error&message=Payment+was+not+completed+successfully+(Status:+${chargeNode.status})`
      );
    }

    // 4. SEC-12: Shopify test charges (free, e.g. on development stores) never
    //    grant credits in production.
    if (!isCreditableCharge(chargeNode)) {
      console.warn(`[billing-callback] refusing test charge ${chargeNode.id} in this environment`);
      return Response.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?billing=error&message=Test+charges+cannot+be+used+to+buy+credits`
      );
    }

    // 5. Map the charge to a plan: exact name for app-created one-time
    //    purchases; unambiguous plan keyword for managed-pricing subscriptions.
    const name = chargeNode.name || "";
    const chargeKind = result.data?.oneTime?.id ? "one_time" : "subscription";
    const plan = planForShopifyCharge(name, chargeKind);
    if (!plan) {
      console.error(`Unrecognized charge name: ${name}`);
      return Response.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?billing=error&message=Unrecognized+plan+name`
      );
    }
    const creditsToAdd: number = plan.credits;
    const planName: string = plan.label;

    // 6. Idempotency: claim this charge before granting so a callback replay
    //    (refresh, back-button, double redirect) can never double-credit. A
    //    lost claim means the charge was already processed — redirect to
    //    success without granting again.
    const claimId = `shopify:${globalId}`;
    const claimed = await claimPayment(claimId);
    if (!claimed) {
      console.log(`[billing-callback] charge ${globalId} already processed — skipping grant`);
      return Response.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?billing=success&credits=${creditsToAdd}&plan=${planName}`
      );
    }

    // 7. Grant the credits. When we know the payer (uid), credit that exact
    //    account, writing BOTH balance columns so every reader sees the new
    //    balance; otherwise fall back to the legacy shop-keyed path. If the
    //    grant fails, release the claim so a retry can re-process the charge.
    try {
      await addCreditsToUser(uid, creditsToAdd);
    } catch (grantError) {
      await releasePayment(claimId).catch(() => {});
      throw grantError;
    }

    // 8. Record the transaction (bookkeeping only — never blocks the grant).
    if (uid) {
      try {
        await createPayment({
          clerk_user_id: uid,
          provider: "shopify",
          pack: planName.toLowerCase(),
          amount_usd: Number(chargeNode.price?.amount) || null,
          currency: chargeNode.price?.currencyCode || "USD",
          credits_granted: creditsToAdd,
          unlimited_days: 0,
          status: "success",
          provider_reference: globalId,
        });
      } catch (recordError) {
        console.error("[billing-callback] failed to record payment (credits were granted):", recordError);
      }
    }

    // 9. Redirect to dashboard with success query param
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?billing=success&credits=${creditsToAdd}&plan=${planName}`
    );
  } catch (error) {
    console.error("Error in billing callback route:", error);
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?billing=error&message=Internal+server+error+during+callback`
    );
  }
}
