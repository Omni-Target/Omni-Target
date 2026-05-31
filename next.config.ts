import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ensure @sparticuz/chromium and puppeteer-core are bundled as externals for serverless functions.
  // This is required for Puppeteer PDF generation on Vercel.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
};

export default nextConfig;
