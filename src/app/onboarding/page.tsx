import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getOnboardingStep } from "@/lib/onboarding";

export default async function OnboardingPage(props: {
  searchParams?: Promise<{ plan?: string; from?: string }>;
}) {
  const { userId } = await auth();
  if (!userId) {
    redirect("/login");
  }

  const params = await props.searchParams;
  const planQuery = params?.plan ? `?plan=${encodeURIComponent(params.plan)}` : "";

  const step = await getOnboardingStep(userId);
  if (step === "complete") {
    redirect(`/dashboard${planQuery}`);
  }
  redirect(`/onboarding/${step}${planQuery}`);
}

