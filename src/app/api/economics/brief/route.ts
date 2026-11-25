import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api/require-user";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { normalizeMaxTotalBudget } from "@/lib/budget-plan";
import { getCampaign, tenantFor } from "@/modules/campaigns/repository";
import { economicsForBrief } from "@/modules/economics/brief-run";

/**
 * Recalculates a brief product's economics and budget (Phase 4, task 8), saving the merchant's maximum for this
 * test as the product's own limit. The brief itself changes only when it is saved (PUT /api/campaigns/[id]),
 * which recalculates again on the server. The product comes from the saved brief, never from the request.
 */
export async function POST(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const limited = await enforceRateLimit({ action: "economics:brief", identifier: auth.userId, limit: 60, windowSeconds: 600 });
  if (!limited.ok) return limited.response;
  const body = (await request.json().catch(() => null)) as { campaignId?: unknown; maxTestBudget?: unknown; testDays?: unknown; confirmZeroCost?: unknown } | null;
  if (!body || typeof body.campaignId !== "string") return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  if (body.testDays !== undefined && ![7, 14, 30].includes(body.testDays as number)) return NextResponse.json({ error: "Invalid duration" }, { status: 400 });
  const max = body.maxTestBudget;
  const parsed = max === undefined || max === null || max === "" ? null : normalizeMaxTotalBudget(max);
  if (max !== undefined && max !== null && max !== "" && parsed === null) return NextResponse.json({ error: "Invalid maximum test budget" }, { status: 400 });
  const tenant = await tenantFor(auth.userId);
  const campaign = tenant ? await getCampaign(tenant, body.campaignId) : null;
  if (!tenant || !campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const productId = (campaign.brief_data as { productShopifyId?: unknown } | null)?.productShopifyId;
  if (productId === undefined || productId === null) return NextResponse.json({ error: "This brief has no product economics" }, { status: 409 });
  const economics = await economicsForBrief({ userId: auth.userId, productId: productId as string | number, testDays: body.testDays as number | undefined,
    testLimit: max === undefined ? undefined : parsed, confirmZeroCost: body.confirmZeroCost === true });
  return NextResponse.json({ economics });
}
