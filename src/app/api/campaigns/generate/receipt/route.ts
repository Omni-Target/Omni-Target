import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api/require-user";
import { getGenerationReceiptById } from "@/lib/db";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;

  const requestId = new URL(request.url).searchParams.get("requestId");
  if (!requestId || !UUID_PATTERN.test(requestId)) {
    return NextResponse.json({ error: "Invalid request ID" }, { status: 400, headers: NO_STORE });
  }

  try {
    const receipt = await getGenerationReceiptById(authResult.userId, requestId);
    if (!receipt) {
      return NextResponse.json({ status: "pending" }, { status: 202, headers: NO_STORE });
    }
    return NextResponse.json({ status: "complete", receipt }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Brief save status is temporarily unavailable." }, { status: 503, headers: NO_STORE });
  }
}
