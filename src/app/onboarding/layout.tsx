import React from "react";

// Each onboarding page renders its own <OnboardingShell> so the progress rail
// can reflect the current step. This layout is a thin pass-through.
export default function OnboardingGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
