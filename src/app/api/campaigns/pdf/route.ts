import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api/require-user";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { BriefPDFParams } from "@/lib/generate-brief-pdf";
import { buildBriefHTML } from "@/lib/brief-html-template";

export const maxDuration = 60;

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

  try {
    // Generate the HTML for the brief
    const html = await buildBriefHTML(params);

    // Return the HTML directly so the client can render it via html2pdf.js!
    // This completely bypasses Vercel's serverless function size limits and Puppeteer/Chromium dependency issues.
    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html",
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[PDF API] HTML Generation error:", message);
    return NextResponse.json(
      { error: "Failed to generate brief HTML", detail: message },
      { status: 500 }
    );
  }
}
