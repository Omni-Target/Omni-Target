import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api/require-user";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { pdfFileName } from "@/lib/brief-pdf-types";
import { MAX_PDF_BODY_BYTES, parseBriefPdfParams } from "@/lib/brief-pdf-schema";
import { buildBriefHTML } from "@/lib/brief-html-template";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Renders a campaign brief to HTML (in-app preview) or PDF (download).
 *
 * SEC-06: the payload comes from the browser, so it is size-capped and
 * schema-validated before rendering; the HTML carries a strict document CSP
 * (no script, no external requests), the preview iframe is sandboxed, and the
 * headless Chromium renderer blocks every non-data: request.
 */
export async function POST(request: Request) {
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;
  const { userId } = authResult;

  const limited = await enforceRateLimit({
    action: "campaigns:pdf",
    identifier: userId,
    limit: 40,
    windowSeconds: 3600,
  });
  if (!limited.ok) return limited.response;

  // JSON only: a cross-site HTML form cannot send application/json without a
  // CORS preflight, so this also closes the form-POST path to this endpoint.
  if (!(request.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_PDF_BODY_BYTES) {
    return NextResponse.json({ error: "Brief payload too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validated = parseBriefPdfParams(body);
  if (!validated.ok) {
    return NextResponse.json({ error: "Invalid brief payload", field: validated.error }, { status: 400 });
  }
  const params = validated.params;

  const searchParams = new URL(request.url).searchParams;
  // `format=pdf` → render a real, downloadable PDF via headless Chromium.
  // `embed=1`    → HTML with no toolbar/auto-print, for the in-app modal preview.
  // (none)       → HTML with the toolbar + auto-print, for the standalone tab.
  const wantsPdf = searchParams.get("format") === "pdf";
  const embed = wantsPdf || searchParams.get("embed") === "1";

  try {
    // The same HTML document powers the preview and the download, so they match.
    const html = await buildBriefHTML(params, { embed });

    if (wantsPdf) {
      // Render with the real browser engine so the file is a faithful, vector
      // reproduction of the preview (correct fonts, icons, spacing, colors).
      const { renderHtmlToPdf } = await import("@/lib/pdf/render-pdf");
      const pdf = await renderHtmlToPdf(html);
      return new NextResponse(new Uint8Array(pdf), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${pdfFileName(params)}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err: unknown) {
    console.error("[PDF API] Generation error:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "Failed to generate brief" }, { status: 500 });
  }
}
