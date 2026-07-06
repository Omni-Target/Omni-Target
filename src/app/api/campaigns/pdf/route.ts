import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api/require-user";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { BriefPDFParams } from "@/lib/brief-pdf-types";
import { buildBriefHTML } from "@/lib/brief-html-template";

export const runtime = "nodejs";
export const maxDuration = 60;

function briefFileName(params: BriefPDFParams): string {
  return `omni-target-brief-${(params.productName || "campaign")
    .replace(/\s+/g, "-")
    .toLowerCase()}.pdf`;
}

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

  let params: BriefPDFParams;
  try {
    params = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

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
          "Content-Disposition": `attachment; filename="${briefFileName(params)}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html",
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[PDF API] Generation error:", message);
    return NextResponse.json(
      { error: "Failed to generate brief", detail: message },
      { status: 500 }
    );
  }
}
