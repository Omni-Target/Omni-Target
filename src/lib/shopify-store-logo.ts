import { isIP } from "node:net";
import { normalizeStoreLogoUrl } from "@/lib/store-logo-url";

function decodeAttribute(value: string): string {
  return value.replace(/&(?:amp|quot|apos|#39|#x27|#(\d+));/gi, (match, decimal: string) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    const entity = match.toLowerCase();
    if (entity === "&amp;") return "&";
    if (entity === "&quot;") return '"';
    return "'";
  });
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? decodeAttribute(match[1] ?? match[2] ?? match[3]) : null;
}

function imageUrl(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(imageUrl).find(Boolean) ?? null;
  if (value && typeof value === "object") {
    const image = value as Record<string, unknown>;
    return imageUrl(image.url) ?? imageUrl(image.contentUrl);
  }
  return null;
}

function organizationLogo(value: unknown): string | null {
  if (Array.isArray(value)) return value.map(organizationLogo).find(Boolean) ?? null;
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
  if (types.some((type) => typeof type === "string" && /^(Organization|Store|OnlineStore)$/i.test(type))) {
    return imageUrl(item.logo);
  }
  return organizationLogo(item["@graph"]);
}

function resolveLogo(raw: string | null, origin: string): string | null {
  if (!raw) return null;
  try {
    return normalizeStoreLogoUrl(new URL(raw, origin).toString());
  } catch {
    return null;
  }
}

/** Read only explicit logo signals; never substitute the homepage hero image. */
export function extractStoreLogoFromHtml(html: string, origin: string): string | null {
  for (const script of html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)) {
    const tag = script[0].slice(0, script[0].indexOf(">") + 1);
    if (attribute(tag, "type")?.toLowerCase() !== "application/ld+json") continue;
    try {
      const content = script[0].slice(tag.length, -"</script>".length);
      const logo = resolveLogo(organizationLogo(JSON.parse(content)), origin);
      if (logo) return logo;
    } catch {
      // A malformed JSON-LD block should not hide a valid theme logo.
    }
  }

  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const marker = `${attribute(tag, "class") ?? ""} ${attribute(tag, "id") ?? ""} ${attribute(tag, "alt") ?? ""}`;
    if (!/(?:^|[\s_-])logo(?:[\s_-]|$)/i.test(marker)) continue;
    let rawSrc = attribute(tag, "data-src") ?? attribute(tag, "src");
    if (!rawSrc || rawSrc.startsWith("data:")) {
      const srcset = attribute(tag, "srcset");
      if (srcset) {
        const candidates = srcset.split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
        rawSrc = candidates[candidates.length - 1] || candidates[0] || null;
      }
    }
    const logo = resolveLogo(rawSrc, origin);
    if (logo) return logo;
  }

  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\b(?:icon|apple-touch-icon|shortcut\s+icon)\b/i.test(attribute(tag, "rel") ?? "")) continue;
    const logo = resolveLogo(attribute(tag, "href"), origin);
    if (logo && /(?:cdn\.shopify\.com|\/cdn\/shop\/)/i.test(logo)) return logo;
  }

  return null;
}

function safeStorefrontHost(value?: string | null): string | null {
  if (!value) return null;
  const host = value.trim().toLowerCase();
  if (host.length > 253 || isIP(host) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) return null;
  if (/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(host)) return null;
  return host;
}

async function readLimitedHtml(response: Response): Promise<string | null> {
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return null;
  const maxBytes = 2_000_000;
  if (Number(response.headers.get("content-length")) > maxBytes) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function fetchShopifyStoreLogo(
  myshopifyDomain: string,
  customDomain?: string | null,
): Promise<string | null> {
  const shop = safeStorefrontHost(myshopifyDomain);
  if (!shop?.endsWith(".myshopify.com")) return null;
  const custom = safeStorefrontHost(customDomain);
  const hosts = [...new Set([custom, shop].filter((host): host is string => !!host))];

  for (const host of hosts) {
    try {
      let currentHost: string | null = host;
      for (let redirectCount = 0; redirectCount < 3 && currentHost; redirectCount++) {
        const response = await fetch(`https://${currentHost}/`, {
          headers: { Accept: "text/html" },
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) break;
          try {
            const redirectUrl = new URL(location, `https://${currentHost}/`);
            const nextHost = safeStorefrontHost(redirectUrl.hostname);
            if (nextHost && nextHost !== currentHost) {
              currentHost = nextHost;
              continue;
            }
          } catch {
            break;
          }
        }

        const html = await readLimitedHtml(response);
        if (!html) break;
        const logo = extractStoreLogoFromHtml(html, `https://${currentHost}/`);
        if (logo) return logo;
        break;
      }
    } catch {
      // The storefront can be password-protected or temporarily unavailable.
    }
  }
  return null;
}
