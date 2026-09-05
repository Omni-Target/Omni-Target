import { clerkClient } from "@clerk/nextjs/server";

export type OnboardingStep =
  | "connect-shopify"
  | "audit"
  | "complete";

/**
 * Returns the user's current onboarding step from Clerk publicMetadata.
 * Defaults to "connect-shopify" for brand-new users.
 */
export async function getOnboardingStep(
  userId: string
): Promise<OnboardingStep> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const metadata = user.publicMetadata as {
    onboardingStep?: string;
    shopifyStoreUrl?: string;
  };
  const step = metadata?.onboardingStep;

  if (step === "complete") {
    return "complete";
  }

  // Handle legacy "connect-meta" step or ongoing audit
  if (step === "connect-meta" || step === "audit") {
    return "audit";
  }

  // If user already has a connected Shopify store in Clerk metadata, skip connect-shopify!
  if (metadata?.shopifyStoreUrl) {
    return "audit";
  }

  // Fallback: check database in case metadata hasn't synced
  try {
    const { getUserIntegration } = await import("@/lib/db");
    const integration = await getUserIntegration(userId);
    if (
      integration?.shopify_store_url ||
      integration?.shop_domain ||
      integration?.shopify_access_token ||
      integration?.access_token
    ) {
      const storeUrl =
        integration.shopify_store_url ||
        integration.shop_domain ||
        "connected";
      // Sync to metadata asynchronously so subsequent calls don't need DB check
      Promise.resolve(
        client.users.updateUserMetadata(userId, {
          publicMetadata: {
            shopifyStoreUrl: storeUrl,
            onboardingStep: "audit",
          },
        })
      ).catch(() => {});
      return "audit";
    }
  } catch (dbErr) {
    console.warn("Could not check integration in getOnboardingStep:", dbErr);
  }

  return "connect-shopify";
}

/**
 * Persists the user's current onboarding step in Clerk publicMetadata.
 */
export async function setOnboardingStep(
  userId: string,
  step: OnboardingStep
): Promise<void> {
  const client = await clerkClient();
  await client.users.updateUserMetadata(userId, {
    publicMetadata: { onboardingStep: step },
  });
}
