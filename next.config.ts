import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ensure @sparticuz/chromium-min and puppeteer-core are bundled as externals for serverless functions.
  // This is required for Puppeteer PDF generation on Vercel.
  serverExternalPackages: ["@sparticuz/chromium-min", "puppeteer-core"],
};

export default nextConfig;
