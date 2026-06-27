// Launched by `shopify app dev` via shopify.web.toml ([commands].dev).
//
// Why this exists: this app implements Shopify OAuth manually and builds the
// OAuth redirect_uri + webhook addresses from NEXT_PUBLIC_APP_URL. During
// `shopify app dev`, the CLI rewrites the Partner Dashboard redirect allowlist
// to the ephemeral Cloudflare tunnel URL — so NEXT_PUBLIC_APP_URL must match
// that tunnel, or Shopify rejects the callback ("redirect_uri is not
// whitelisted"). The CLI injects the tunnel URL into this process as HOST /
// APP_URL, and the port it forwards the tunnel to as FRONTEND_PORT, so we map
// those onto the values Next expects before starting the dev server.
//
// Real env vars take precedence over .env.local in Next.js, so setting
// NEXT_PUBLIC_APP_URL here overrides the localhost value for server-side
// routes (the OAuth connect/callback handlers).

import { spawn } from "node:child_process";

const tunnelUrl = process.env.HOST || process.env.APP_URL;
const port = process.env.FRONTEND_PORT || process.env.BACKEND_PORT || "3000";

const env = { ...process.env };
if (tunnelUrl) {
  env.NEXT_PUBLIC_APP_URL = tunnelUrl;
  console.log(`[shopify-dev] NEXT_PUBLIC_APP_URL -> ${tunnelUrl}`);
  console.log(`[shopify-dev] next dev on port ${port} (tunnel forwards here)`);
} else {
  console.warn(
    "[shopify-dev] No HOST/APP_URL injected by the CLI — " +
      "falling back to NEXT_PUBLIC_APP_URL from .env.local. " +
      "OAuth will likely fail with a redirect_uri mismatch."
  );
}

const child = spawn("npx", ["next", "dev", "-p", String(port)], {
  stdio: "inherit",
  shell: true,
  env,
});

child.on("exit", (code) => process.exit(code ?? 0));
