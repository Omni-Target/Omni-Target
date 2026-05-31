import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import chromium from "@sparticuz/chromium";
import puppeteerCore from "puppeteer-core";
import { BriefPDFParams } from "@/lib/generate-brief-pdf";
import { buildBriefHTML } from "@/lib/brief-html-template";
import path from "path";

// Vercel serverless functions have a max duration — bump to 60s for PDF gen
export const maxDuration = 60;

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

  let browser: Awaited<ReturnType<typeof puppeteerCore.launch>> | null = null;

  try {
    const html = await buildBriefHTML(params);

    // On Vercel (production), use @sparticuz/chromium which bundles a serverless-compatible Chromium.
    // Locally, fall back to the system-installed Chrome/Chromium.
    const isLocal = process.env.NODE_ENV === "development" || !process.env.VERCEL;

    if (isLocal) {
      // Local dev — use system chromium or puppeteer's bundled chrome
      const puppeteer = (await import("puppeteer")).default;
      browser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--font-render-hinting=none",
        ],
      });
    } else {
      // Vercel production — use @sparticuz/chromium
      const executablePath = await chromium.executablePath();
      
      // CRITICAL: Set LD_LIBRARY_PATH so Chromium can find its shared libraries on Vercel
      process.env.LD_LIBRARY_PATH = path.dirname(executablePath);

      browser = await puppeteerCore.launch({
        args: chromium.args,
        defaultViewport: (chromium as any).defaultViewport,
        executablePath,
        headless: (chromium as any).headless,
      });
    }

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });

    const pdfBuffer = Buffer.from(
      await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
      })
    );

    await browser.close();
    browser = null;

    const safeName = (params.productName || "brief")
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase();

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
    return NextResponse.json(
      { error: "PDF generation failed", detail: message },
      { status: 500 }
    );
  } finally {
    // Always close the browser, even on error
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore close errors */
      }
    }
  }
}
