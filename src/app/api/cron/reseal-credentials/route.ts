import { NextResponse } from "next/server";
import { captureBackgroundFailure } from "@/lib/observability/capture";
import { safeEqual } from "@/lib/shopify-oauth";
import { resealBelowCurrentKey } from "@/modules/credentials/rotation";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Key rotation sweep (Phase 1, task 4). Not scheduled: run by hand with
 * CRON_SECRET after deploying a new APP_ENCRYPTION_KEY_VERSION, repeating
 * until `remaining` is 0 (scripts/ops/runbooks/credential-keys.md).
 * Answers with counts only.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await resealBelowCurrentKey());
  } catch (error) {
    captureBackgroundFailure("credential-reseal", error);
    return NextResponse.json({ error: "Re-encryption failed" }, { status: 500 });
  }
}
