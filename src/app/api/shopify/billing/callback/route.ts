import {
  getIntegrationByShop,
  getIntegrationByUser,
  addCreditsToIntegration,
  addCreditsToUser,
} from "@/lib/billing-db";
import { claimPayment, releasePayment, createPayment } from "@/lib/db";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chargeId = searchParams.get("charge_id");
  const shop = searchParams.get("shop");
  // Present on charges initiated after the user-scoped billing fix; lets us
  // attribute credits to the exact payer even when a shop is shared.
  const uid = searchParams.get("uid");

  console.log(
    `Shopify billing callback received. Shop: ${shop}, Charge ID: ${chargeId}, User: ${uid ?? "(legacy)"}`
  );

  if (!chargeId || !shop) {
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?billing=error&message=Missing+charge_id+or+shop`
    );
  }

  try {
    // 1. Retrieve access token. Prefer the user-scoped lookup (unique key, no
    //    ambiguity for shared stores); fall back to shop for legacy charges.
    const integration = uid
      ? await getIntegrationByUser(uid)
      : await getIntegrationByShop(shop);
    if (!integration || !integration.access_token) {
      console.error(
        `Integration or token not found for ${uid ? `user: ${uid}` : `shop: ${shop}`}`
      );
      return Response.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?billing=error&message=Shopify+integration+not+found`
      );
    }

    // 2. Query the charge from Shopify GraphQL API
    const globalId = chargeId.startsWith("gid://")
      ? chargeId
      : `gid://shopify/AppPurchaseOneTime/${chargeId}`;

    const query = `
      query GetAppPurchaseOneTime($id: ID!) {
        node(id: $id) {
          ... on AppPurchaseOneTime {
            id
            name
            status
            price {
              amount
              currencyCode
            }
          }
        }
      }
    `;

    const shopifyUrl = `https://${shop}/admin/api/2026-01/graphql.json`;
    const response = await fetch(shopifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": integration.access_token,
      },
      body: JSON.stringify({
        query,
        variables: { id: globalId },
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
    if (result.errors) {
      console.error("Shopify GraphQL errors while fetching charge:", result.errors);
      return Response.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?billing=error&message=Shopify+GraphQL+error`
      );
    }

    const chargeNode = result.data?.node;
    if (!chargeNode) {
      console.error(`No charge node found for ID: ${globalId}`);
      return Response.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?billing=error&message=Charge+not+found`
      );
    }

    console.log(`Retrieved charge from Shopify:`, chargeNode);

    // 3. Verify charge is ACTIVE
    if (chargeNode.status !== "ACTIVE") {
      console.warn(`Charge status is not ACTIVE. Current status: ${chargeNode.status}`);
      return Response.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?billing=error&message=Payment+was+not+completed+successfully+(Status:+${chargeNode.status})`
      );
    }

    // 4. Map charge name to credits
    const name = chargeNode.name || "";
    let creditsToAdd = 0;
    let planName = "";

    if (name.toLowerCase().includes("starter")) {
      creditsToAdd = 5;
      planName = "Starter";
    } else if (name.toLowerCase().includes("growth")) {
      creditsToAdd = 15;
      planName = "Growth";
    } else if (name.toLowerCase().includes("scale")) {
      creditsToAdd = 30;
      planName = "Scale";
    } else {
      console.error(`Unrecognized charge name: ${name}`);
      return Response.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?billing=error&message=Unrecognized+plan+name`
      );
    }

    // 5. Idempotency: claim this charge before granting so a callback replay
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

    // 6. Grant the credits. When we know the payer (uid), credit that exact
    //    account, writing BOTH balance columns so every reader sees the new
    //    balance; otherwise fall back to the legacy shop-keyed path. If the
    //    grant fails, release the claim so a retry can re-process the charge.
    try {
      if (uid) {
        await addCreditsToUser(uid, creditsToAdd);
      } else {
        await addCreditsToIntegration(shop, creditsToAdd);
      }
    } catch (grantError) {
      await releasePayment(claimId).catch(() => {});
      throw grantError;
    }

    // 7. Record the transaction (bookkeeping only — never blocks the grant).
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

    // 8. Redirect to dashboard with success query param
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
