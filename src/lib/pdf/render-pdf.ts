import type { Browser } from "puppeteer-core";

/**
 * Renders HTML to a faithful, vector PDF using a real Chromium engine — the
 * same engine that paints the in-app preview iframe — so the download matches
 * the preview exactly (real fonts, real inline-SVG icons, correct spacing and
 * colors; nothing is rasterized or re-laid-out).
 *
 * Locally we use the full `puppeteer` (ships its own Chromium). On serverless
 * (Vercel/Lambda) we use `puppeteer-core` + `@sparticuz/chromium-min`, which is
 * small enough for the function size limits. Callers should treat a thrown
 * error as "fall back to the browser print dialog".
 */
async function launchBrowser(): Promise<Browser> {
  const serverless =
    !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

  if (serverless) {
    const chromium = (await import("@sparticuz/chromium-min")).default;
    const puppeteer = await import("puppeteer-core");
    // For @sparticuz/chromium-min the Chromium binary is fetched from a hosted
    // brotli pack at runtime; the URL is supplied via env so the deployed
    // bundle stays tiny.
    const executablePath = await chromium.executablePath(
      process.env.CHROMIUM_PACK_URL,
    );
    return puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: true,
    });
  }

  const puppeteer = (await import("puppeteer")).default;
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return browser as unknown as Browser;
}

export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    // The HTML embeds its fonts/images as data URIs, so there are no external
    // requests — but wait for fonts so nothing snapshots mid-swap.
    await page.setContent(html, { waitUntil: "load" });
    try {
      await page.evaluate(async () => {
        if (document.fonts && document.fonts.ready) {
          await document.fonts.ready;
        }
      });
    } catch {
      // Non-fatal — fonts are embedded, ready() is just a best-effort barrier.
    }

    // Match the preview: render in "screen" media so the document keeps the
    // same layout the user reviewed (rather than a separate print stylesheet).
    await page.emulateMediaType("screen");

    const data = await page.pdf({
      format: "a4",
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    return Buffer.from(data);
  } finally {
    await browser.close();
  }
}
