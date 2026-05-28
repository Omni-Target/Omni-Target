import { getIntegrationByShop, addCreditsToIntegration } from "@/lib/billing-db";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chargeId = searchParams.get("charge_id");
  const shop = searchParams.get("shop");

  console.log(`Shopify billing callback received. Shop: ${shop}, Charge ID: ${chargeId}`);

  if (!chargeId || !shop) {
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?billing=error&message=Missing+charge_id+or+shop`
    );
  }

  try {
    // 1. Retrieve access token
    const integration = await getIntegrationByShop(shop);
    if (!integration || !integration.access_token) {
      console.error(`Integration or token not found for shop: ${shop}`);
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

    // 5. Add credits in Supabase
    await addCreditsToIntegration(shop, creditsToAdd);

    // 6. Redirect to dashboard with success query param
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
