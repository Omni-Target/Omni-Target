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
  const step = (user.publicMetadata as { onboardingStep?: string })
    ?.onboardingStep;

  // Handle legacy "connect-meta" step
  if (step === "connect-meta" || step === "audit") {
    return "audit";
  }
  if (step === "complete") {
    return "complete";
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
