import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import puppeteer from "puppeteer";
import { BriefPDFParams } from "@/lib/generate-brief-pdf";
import { buildBriefHTML } from "@/lib/brief-html-template";

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let params: BriefPDFParams;
  try {
    params = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const html = await buildBriefHTML(params);

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--font-render-hinting=none",
      ],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });

    const pdfBuffer = Buffer.from(await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
    }));

    await browser.close();

    const safeName = params.productName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    return new NextResponse(pdfBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="omni-target-brief-${safeName}.pdf"`,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : "";
    console.error("[PDF] Generation error:", message);
    console.error("[PDF] Stack:", stack);
    console.error("[PDF] Params snapshot:", JSON.stringify({
      productName: (params as BriefPDFParams).productName,
      hasCopy: !!(params as BriefPDFParams).copy,
      hasTargeting: !!(params as BriefPDFParams).targeting,
      hasBudget: !!(params as BriefPDFParams).budget,
      locationCount: (params as BriefPDFParams).targeting?.locations?.length ?? "n/a",
      warningsCount: (params as BriefPDFParams).warnings?.length ?? "n/a",
    }));
    return NextResponse.json({ error: "PDF generation failed", detail: message }, { status: 500 });
  }
}
