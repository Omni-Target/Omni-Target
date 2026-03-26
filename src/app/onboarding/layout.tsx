import React from "react";
import OnboardingLayout from "@/components/onboarding-layout";

export default function OnboardingGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <OnboardingLayout>{children}</OnboardingLayout>;
}
