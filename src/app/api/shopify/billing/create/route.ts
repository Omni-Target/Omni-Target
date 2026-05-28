import { auth } from "@clerk/nextjs/server";
import { getIntegrationByShop } from "@/lib/billing-db";

const PLANS = {
  starter: {
    name: "Starter Pack – 5 Credits",
    price: "39.00",
  },
  growth: {
    name: "Growth Pack – 15 Credits",
    price: "99.00",
  },
  scale: {
    name: "Scale Pack – 30 Credits",
    price: "179.00",
  },
} as const;

type PlanKey = keyof typeof PLANS;

export async function POST(request: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const { shop, plan } = await request.json();

    if (!shop || !plan) {
      return Response.json(
        { error: "Missing required fields: shop and plan" },
        { status: 400 }
      );
    }

    const planInfo = PLANS[plan as PlanKey];
    if (!planInfo) {
      return Response.json(
        { error: `Invalid plan. Must be one of: ${Object.keys(PLANS).join(", ")}` },
        { status: 400 }
      );
    }

    // Retrieve the Shopify integration from Supabase
    const integration = await getIntegrationByShop(shop);
    if (!integration || !integration.access_token) {
      return Response.json(
        { error: "Shopify integration not found or access token missing" },
        { status: 404 }
      );
    }

    // Verify the integration belongs to the logged-in Clerk user for security
    if (integration.clerk_user_id !== userId) {
      return Response.json(
        { error: "Forbidden: You do not own this integration" },
        { status: 403 }
      );
    }

    // Call Shopify GraphQL API
    const query = `
      mutation AppPurchaseOneTimeCreate($name: String!, $price: MoneyInput!, $returnUrl: URL!, $test: Boolean) {
        appPurchaseOneTimeCreate(name: $name, price: $price, returnUrl: $returnUrl, test: $test) {
          userErrors {
            field
            message
          }
          appPurchaseOneTime {
            id
            confirmationUrl
          }
        }
      }
    `;

    const returnUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/shopify/billing/callback?shop=${encodeURIComponent(shop)}`;
    
    // Default to test mode in development, or if configured
    const testMode = process.env.NODE_ENV !== "production" || process.env.SHOPIFY_TEST_BILLING === "true";

    const variables = {
      name: planInfo.name,
      price: {
        amount: planInfo.price,
        currencyCode: "USD",
      },
      returnUrl,
      test: testMode,
    };

    const shopifyUrl = `https://${shop}/admin/api/2026-01/graphql.json`;
    console.log(`Initiating Shopify one-time billing for ${shop}. Plan: ${plan}, Price: $${planInfo.price}, Test Mode: ${testMode}`);

    const response = await fetch(shopifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": integration.access_token,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Shopify billing API error response: ${response.status} ${response.statusText}`, errorText);
      return Response.json(
        { error: "Failed to create Shopify billing purchase" },
        { status: 502 }
      );
    }

    const result = await response.json();

    if (result.errors) {
      console.error("Shopify GraphQL errors:", result.errors);
      return Response.json(
        { error: "Shopify GraphQL error", details: result.errors },
        { status: 500 }
      );
    }

    const purchaseCreate = result.data?.appPurchaseOneTimeCreate;
    if (purchaseCreate?.userErrors && purchaseCreate.userErrors.length > 0) {
      console.error("Shopify mutation user errors:", purchaseCreate.userErrors);
      return Response.json(
        { error: "Shopify billing mutation failed", details: purchaseCreate.userErrors },
        { status: 400 }
      );
    }

    const confirmationUrl = purchaseCreate?.appPurchaseOneTime?.confirmationUrl;
    if (!confirmationUrl) {
      console.error("Shopify returned no confirmation URL:", result);
      return Response.json(
        { error: "Did not receive a confirmation URL from Shopify" },
        { status: 500 }
      );
    }

    return Response.json({ confirmationUrl });
  } catch (error) {
    console.error("Error creating billing purchase:", error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
