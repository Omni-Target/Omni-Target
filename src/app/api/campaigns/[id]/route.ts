import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api/require-user";
import { getCampaignById, getBriefVersions, finalizeBriefVersion } from "@/lib/db";
import { computeBudgetPlan, normalizeMaxTotalBudget, savedMaxTestBudget } from "@/lib/budget-plan";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;
  const { userId } = authResult;
  const { id } = await params;
  const campaign = await getCampaignById(userId, id);
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const versions = await getBriefVersions(userId, id);
  const version = versions.find((v) => v.id === body.versionId) ??
    (!body.versionId ? versions.find((v) => v.is_selected) : undefined);
  if (!version) return NextResponse.json({ error: "Version not found" }, { status: 404 });
  const context = body.briefData;
  if (context && (typeof context !== "object" || Array.isArray(context))) {
    return NextResponse.json({ error: "Invalid brief context" }, { status: 400 });
  }
  for (const key of ["selectedDuration", "selectedIntlDuration"]) {
    if (context?.[key] !== undefined && ![7, 14, 30].includes(context[key])) {
      return NextResponse.json({ error: "Invalid duration" }, { status: 400 });
    }
  }
  for (const key of ["selectedStrategyIndex", "selectedIntlStrategyIndex"]) {
    if (context?.[key] !== undefined && ![0, 1, 2].includes(context[key])) {
      return NextResponse.json({ error: "Invalid strategy" }, { status: 400 });
    }
  }
  // S0.6: the stored budget plan is computed here from the merchant's own
  // maximum test budget — never taken from client-sent amounts. Currency comes
  // from the saved campaign, not from the request.
  if (context) {
    const explicitMax = context.maxTestBudget;
    if (explicitMax !== undefined && explicitMax !== null && explicitMax !== "" && normalizeMaxTotalBudget(explicitMax) === null) {
      return NextResponse.json({ error: "Invalid maximum test budget" }, { status: 400 });
    }
    // An explicit value (or null/"" to clear) is the merchant's edit. Callers
    // that do not send one — e.g. saving a newly generated variation — keep the
    // cap already on this brief or campaign instead of silently resetting it.
    const maxTotalBudget = explicitMax !== undefined
      ? explicitMax
      : savedMaxTestBudget(context) ?? savedMaxTestBudget(campaign.brief_data);
    const saved = (campaign.brief_data ?? {}) as {
      storeInsights?: { store?: { currency?: string; currency_symbol?: string } };
      aiInsights?: { budget?: { currency?: string; currency_symbol?: string } };
    };
    context.budget_plan = computeBudgetPlan({
      currency: saved.storeInsights?.store?.currency ?? saved.aiInsights?.budget?.currency,
      currencySymbol: saved.storeInsights?.store?.currency_symbol ?? saved.aiInsights?.budget?.currency_symbol,
      maxTotalBudget,
      durationDays: context.selectedDuration,
    });
    delete context.maxTestBudget;
  }
  try {
    await finalizeBriefVersion(userId, id, version.id, context, body.copy, body.status);
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    console.error("Brief save failed", error);
    return NextResponse.json({ error: "Your brief could not be saved. Please retry." }, { status: 503 });
  }
}
