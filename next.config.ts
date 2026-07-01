import type { NextConfig } from "next";

/**
 * Baseline security headers applied to every response.
 *
 * Deliberately conservative so they change no behaviour: this is a standalone
 * SaaS (Clerk auth, own domain — not embedded in the Shopify admin via App
 * Bridge), so frame-blocking is safe. The Content-Security-Policy is limited to
 * `frame-ancestors` only — a full resource CSP (script-src/style-src/…) needs
 * per-app testing and is intentionally left for a dedicated pass so we don't
 * silently break inline scripts/styles or third-party widgets (Clerk, Paystack).
 */
const securityHeaders = [
  // Force HTTPS for a year. No `preload` (that's an irreversible registry commitment).
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  // Stop browsers from MIME-sniffing a response away from its declared type.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Clickjacking protection (legacy header + modern CSP equivalent).
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
  // Don't leak full URLs (which can carry ids/tokens) to other origins.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Drop permissions for hardware/APIs the app does not use.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "on" },
];

const nextConfig: NextConfig = {
  images: {
    // Serve modern formats when the browser supports them.
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "cdn.shopify.com",
        pathname: "**",
      },
      {
        protocol: "https",
        hostname: "res.cloudinary.com",
        pathname: "**",
      },
    ],
  },
  experimental: {
    // Tree-shake large named-export libraries so only used modules are bundled.
    optimizePackageImports: ["lucide-react", "motion"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
