import { auth } from "@clerk/nextjs/server";
import { randomBytes } from "crypto";
import { validateShopifyInput } from "@/lib/domain-validation";
import { SHOPIFY_SCOPE_PARAM } from "@/lib/shopify-config";

export async function GET(request: Request) {
  const { userId } = await auth();

  const { searchParams } = new URL(request.url);
  let shop = searchParams.get("shop")?.trim() || "";
  const from = searchParams.get("from") || (userId ? "onboarding" : "signup");

  // Extract selected plan from query param or fallback cookie
  let plan = searchParams.get("plan")?.trim().toLowerCase() || "";
  if (!plan) {
    const cookieHeader = request.headers.get("cookie") || "";
    const match = cookieHeader.match(/(?:^|;\s*)selected_plan=([^;]+)/);
    if (match) {
      plan = decodeURIComponent(match[1]).toLowerCase();
    }
  }
  const validPlans = ["free", "starter", "growth", "scale"];
  const selectedPlan = validPlans.includes(plan) ? plan : "";

  const appBaseUrl = (process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin).replace(/\/$/, "");
  const returnTarget = from === "login" ? "login" : "signup";
  const planQuery = selectedPlan ? `&plan=${encodeURIComponent(selectedPlan)}` : "";

  if (!shop && userId) {
    const { getUserIntegration } = await import("@/lib/db");
    const integration = await getUserIntegration(userId);
    shop = integration?.shopify_store_url || integration?.shop_domain || "";
  }

  if (!shop) {
    if (!userId) {
      return Response.redirect(
        `${appBaseUrl}/${returnTarget}?error=missing_shop${planQuery}`
      );
    }
    return Response.json(
      { error: "Shop parameter required" },
      { status: 400 }
    );
  }

  // Validate store domain format strictly
  const validation = validateShopifyInput(shop);
  if (!validation.isValid) {
    return Response.redirect(
      `${appBaseUrl}/${returnTarget}?error=invalid_domain&detail=${encodeURIComponent(
        validation.error || "Please enter a valid domain (e.g. yourstore.com or store.myshopify.com)"
      )}${planQuery}`
    );
  }

  shop = validation.normalized;

  if (validation.isCustomDomain) {
    try {
      const { resolveShopifyDomain } = await import("@/lib/shopify-resolver");
      const resolved = await resolveShopifyDomain(shop);
      if (resolved.isShopify && resolved.myshopifyDomain) {
        shop = resolved.myshopifyDomain;
      } else {
        return Response.redirect(
          `${appBaseUrl}/${returnTarget}?error=store_not_found&detail=${encodeURIComponent(
            resolved.error || "We could not find a Shopify store at this domain. Please check the URL or use your store.myshopify.com domain."
          )}${planQuery}`
        );
      }
    } catch (resolveErr) {
      console.warn("Domain resolution error:", resolveErr);
      return Response.redirect(
        `${appBaseUrl}/${returnTarget}?error=store_resolution_failed&detail=${encodeURIComponent(
          "We could not verify this Shopify store. Please check the domain or use your store.myshopify.com domain."
        )}${planQuery}`
      );
    }
  }

  // Generate nonce for security and encode user state + plan intent
  const nonce = randomBytes(16).toString("hex");
  const state = `${nonce}___${from}___${userId || "anonymous"}___${selectedPlan}`;

  const redirectUri = `${appBaseUrl}/api/auth/shopify/callback`;

  // Standard offline token OAuth flow
  const authUrl =
    `https://${shop}/admin/oauth/authorize?` +
    `client_id=${process.env.SHOPIFY_CLIENT_ID}` +
    `&scope=${encodeURIComponent(SHOPIFY_SCOPE_PARAM)}` +
    `&redirect_uri=${redirectUri}` +
    `&state=${state}`;

  const response = new Response(null, {
    status: 302,
    headers: new Headers({
      Location: authUrl,
    }),
  });

  // Store state in cookie for verification
  response.headers.append(
    "Set-Cookie",
    `shopify_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/`
  );

  // Preserve selected_plan cookie
  if (selectedPlan) {
    response.headers.append(
      "Set-Cookie",
      `selected_plan=${selectedPlan}; Secure; SameSite=Lax; Max-Age=3600; Path=/`
    );
  }

  return response;
}
