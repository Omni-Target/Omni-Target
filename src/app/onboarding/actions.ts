"use server";

import { auth } from "@clerk/nextjs/server";
import { setOnboardingStep, type OnboardingStep } from "@/lib/onboarding";

/**
 * Server action called by client onboarding pages to advance the step.
 */
export async function advanceOnboardingStep(
  step: OnboardingStep
): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");
  await setOnboardingStep(userId, step);
}
