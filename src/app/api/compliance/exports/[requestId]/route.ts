import { uuidOrNull } from "@/lib/shopify-oauth";
import { captureBackgroundFailure } from "@/lib/observability/capture";
import { openExport, sha256 } from "@/modules/compliance/export-file";
import { r2ExportStore } from "@/modules/compliance/export-store";
import { authorizeDownload } from "@/modules/compliance/exports-repository";
import { notFound, signedInUser, unauthorized } from "@/modules/workspaces/http";

export const dynamic = "force-dynamic";

/**
 * Delivers a customer data export (Phase 2, task 9) to the owner of the
 * workspace it belongs to, while it is ready (30 days). Anyone else, and any
 * expired or withdrawn export, gets the same 404. The stored file is checked
 * against its recorded SHA-256 and decrypted here; it is never exposed by URL.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const userId = await signedInUser();
  if (!userId) return unauthorized();
  const requestId = uuidOrNull((await params).requestId);
  if (!requestId) return notFound();

  try {
    const grant = await authorizeDownload(requestId, userId);
    if (grant.outcome !== "authorized") return notFound();
    const file = await r2ExportStore().get(grant.object_key);
    if (sha256(file) !== grant.sha256) throw new Error("Export file does not match its recorded checksum");
    const json = openExport(file, requestId);
    const name = `customer-data-${grant.customer_id ?? "request"}-${requestId.slice(0, 8)}.json`;
    return new Response(new Uint8Array(json), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    captureBackgroundFailure("compliance-export-download", error);
    return Response.json({ error: "export_unavailable" }, { status: 500 });
  }
}
