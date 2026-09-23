const TRUSTED_HOSTS = ["cdn.shopify.com", "res.cloudinary.com"];
const MAX_BYTES = 15 * 1024 * 1024;

export function isAllowedImageUrl(raw: string, r2Url = process.env.R2_PUBLIC_URL): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
    const host = url.hostname.toLowerCase();
    if (TRUSTED_HOSTS.includes(host) || (host.endsWith(".myshopify.com") && host !== "myshopify.com")) return true;
    if (!r2Url) return false;
    const configured = new URL(r2Url);
    return configured.protocol === "https:" && host === configured.hostname.toLowerCase();
  } catch { return false; }
}

/** Validate every redirect and bound the body while streaming, before allocating a large buffer. */
export async function fetchSafeImage(raw: string): Promise<Response> {
  let url = raw;
  const signal = AbortSignal.timeout(10_000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!isAllowedImageUrl(url)) throw new Error("Image host is not supported");
    const res = await fetch(url, { redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) throw new Error("Invalid image redirect");
      url = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) { await res.body?.cancel(); throw new Error(`Image fetch failed: ${res.status}`); }
    const contentType = res.headers.get("content-type") || "";
    if (!/^image\/(jpeg|png|webp|gif|avif|heic|heif)(;|$)/i.test(contentType)) {
      await res.body?.cancel(); throw new Error("Unsupported image type");
    }
    if (Number(res.headers.get("content-length")) > MAX_BYTES) {
      await res.body?.cancel(); throw new Error("Image is too large");
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error("Empty image response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error("Image is too large");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(bytes, { headers: { "Content-Type": contentType } });
  }
  throw new Error("Too many image redirects");
}
