import { z } from "zod";
import { getIntegrationByUser } from "@/lib/billing-db";
import { requireUser } from "@/lib/api/require-user";
import { apiError, apiServerError } from "@/lib/api/response";

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

const BodySchema = z.object({
  shop: z.string().min(1).max(255),
  plan: z.enum(["starter", "growth", "scale"]),
});

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
  const { plan } = parsed.data;
  const planInfo = PLANS[plan as PlanKey];

  try {
    // Resolve the integration by the authenticated user rather than by the
    // client-supplied shop. `clerk_user_id` is unique, so this both scopes the
    // purchase to the right account and avoids the PGRST116 "multiple rows"
    // failure when a store is connected under more than one account.
    const integration = await getIntegrationByUser(userId);
    if (!integration || !integration.access_token) {
      return apiError("Shopify integration not found", 404);
    }

    // Use the integration's own shop domain as the authoritative value for the
    // Shopify Admin API call — never trust the client-supplied `shop`.
    const shop = integration.shop_domain;
    if (!shop) {
      return apiError("Shopify integration not found", 404);
    }

    // Call Shopify GraphQL API
    const query = `
      mutation AppPurchaseOneTimeCreate($name: String!, $price: MoneyInput!, $returnUrl: URL!, $test: Boolean) {
        appPurchaseOneTimeCreate(name: $name, price: $price, returnUrl: $returnUrl, test: $test) {
          confirmationUrl
          appPurchaseOneTime {
            id
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    // Include the paying user's id so the callback (which is a Shopify redirect
    // with no auth context) can attribute the credits to the exact account,
    // even when the shop is shared across accounts.
    const returnUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/shopify/billing/callback?shop=${encodeURIComponent(shop)}&uid=${encodeURIComponent(userId)}`;
    
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
      console.error(
        `[billing-create] Shopify HTTP ${response.status} ${response.statusText}`,
        errorText
      );
      return apiError("Couldn't start checkout with Shopify. Please try again.", 502);
    }

    const result = await response.json();

    if (result.errors) {
      console.error(
        "[billing-create] Shopify GraphQL errors:",
        JSON.stringify(result.errors, null, 2)
      );
      return apiError("Couldn't start checkout with Shopify. Please try again.", 502);
    }

    const purchaseCreate = result.data?.appPurchaseOneTimeCreate;
    if (purchaseCreate?.userErrors && purchaseCreate.userErrors.length > 0) {
      console.error(
        "[billing-create] Shopify mutation userErrors:",
        JSON.stringify(purchaseCreate.userErrors, null, 2)
      );
      return apiError("Couldn't start checkout. Please try again.", 400);
    }

    const confirmationUrl = purchaseCreate?.confirmationUrl;
    if (!confirmationUrl) {
      console.error("[billing-create] Shopify returned no confirmation URL:", result);
      return apiError("Couldn't start checkout with Shopify. Please try again.", 502);
    }

    return Response.json({ confirmationUrl });
  } catch (error) {
    return apiServerError("billing-create", error);
  }
}
