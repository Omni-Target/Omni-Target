"use client";

import React, { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, CircleX } from "lucide-react";
import {
  OnboardingShell,
  AuditScanning,
  AUDIT_STEPS,
  AuditResultView,
  type AuditResult,
} from "@/components/onboarding";
import { Button } from "@/components/ui/button";

function AuditContent() {
  const searchParams = useSearchParams();
  const fromDashboard = searchParams.get("from") === "dashboard";

  const [currentStep, setCurrentStep] = useState(0);
  const [auditResult, setAuditResult] = useState<AuditResult | null>(null);
  const [auditError, setAuditError] = useState("");
  const [scanning, setScanning] = useState(true);
  const [completing, setCompleting] = useState(false);

  useEffect(() => {
    const stepInterval = setInterval(() => {
      setCurrentStep((prev) => (prev < AUDIT_STEPS.length - 1 ? prev + 1 : prev));
    }, 1000);

    // After 3s of animation, trigger store data fetch then audit.
    const apiTimer = setTimeout(async () => {
      clearInterval(stepInterval);
      setCurrentStep(AUDIT_STEPS.length);
      try {
        // Populate store_snapshot so the audit endpoint has data to read.
        await fetch("/api/store/data");

        // Run the audit, retrying while it reports "syncing".
        let auditData: AuditResult | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          const res = await fetch("/api/pixel/audit");
          if (!res.ok) throw new Error("Audit API failed");
          const data: AuditResult = await res.json();

          if (data.status !== "syncing") {
            auditData = data;
            break;
          }
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            auditData = data;
          }
        }
        setAuditResult(auditData);
      } catch (err) {
        console.error("Audit error:", err);
        setAuditError("Failed to complete audit. Please try again.");
      } finally {
        setScanning(false);
      }
    }, 3000);

    return () => {
      clearInterval(stepInterval);
      clearTimeout(apiTimer);
    };
  }, []);

  const handleContinue = async () => {
    setCompleting(true);
    if (!fromDashboard) {
      try {
        await fetch("/api/user/update-metadata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ onboardingStep: "complete" }),
        });
      } catch (err) {
        console.error("Failed to update onboarding step:", err);
      }
    }
    // Full page navigation so the middleware re-checks the fresh metadata.
    window.location.href = "/dashboard";
  };

  return (
    <OnboardingShell
      currentStep={2}
      contentClassName={scanning ? "max-w-lg" : "max-w-3xl"}
    >
      {fromDashboard && (
        <Link
          href="/dashboard"
          className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to dashboard
        </Link>
      )}

      {scanning ? (
        <AuditScanning currentStep={currentStep} />
      ) : auditResult ? (
        <AuditResultView
          result={auditResult}
          onContinue={handleContinue}
          completing={completing}
          fromDashboard={fromDashboard}
        />
      ) : auditError ? (
        <div className="rounded-2xl border border-border bg-surface p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-danger-50 text-danger-600">
            <CircleX className="size-7" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">Audit failed</h2>
          <p className="mt-1.5 text-sm text-danger-600">{auditError}</p>
          <Button className="mt-6" onClick={handleContinue} isLoading={completing}>
            {fromDashboard ? "Return to dashboard" : "Continue to dashboard"}
          </Button>
        </div>
      ) : null}
    </OnboardingShell>
  );
}

export default function AuditPage() {
  return (
    <Suspense fallback={null}>
      <AuditContent />
    </Suspense>
  );
}
