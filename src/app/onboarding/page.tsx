import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getOnboardingStep } from "@/lib/onboarding";

export default async function OnboardingPage() {
  const { userId } = await auth();
  if (!userId) {
    redirect("/login");
  }

  const step = await getOnboardingStep(userId);
  if (step === "complete") {
    redirect("/dashboard");
  }
  redirect(`/onboarding/${step}`);
}

