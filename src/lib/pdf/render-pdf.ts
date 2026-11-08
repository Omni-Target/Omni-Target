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
  const fs = await import("fs");
  const localChrome =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    (fs.existsSync("/usr/bin/google-chrome")
      ? "/usr/bin/google-chrome"
      : fs.existsSync("/usr/bin/chromium-browser")
      ? "/usr/bin/chromium-browser"
      : undefined);

  const browser = await puppeteer.launch({
    headless: true,
    ...(localChrome ? { executablePath: localChrome } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return browser as unknown as Browser;
}

/**
 * SEC-06: the rendered HTML is built from browser-supplied data, so the page
 * is network-isolated. The brief embeds every font and image as a data: URI;
 * any other request (http/https to internal or external hosts, file://,
 * ws:// …) is aborted, so injected markup cannot reach the network or local
 * files and nothing can be read back into the PDF.
 */
export function isAllowedRenderRequest(url: string): boolean {
  return url.startsWith("data:") || url === "about:blank";
}

export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (isAllowedRenderRequest(request.url())) {
        void request.continue();
      } else {
        void request.abort("blockedbyclient");
      }
    });

    // Wait for fonts so nothing snapshots mid-swap.
    await page.setContent(html, { waitUntil: "load" });
    try {
      await Promise.race([
        page.evaluate(async () => {
          if (document.fonts && document.fonts.ready) {
            await document.fonts.ready;
          }
        }),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
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
