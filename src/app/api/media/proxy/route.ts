import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { requireUser } from "@/lib/api/require-user";

// Hosts we are willing to proxy images from. An allowlist of known image CDNs
// is the primary SSRF defense: an internal IP / cloud-metadata address
// (e.g. 169.254.169.254, 127.0.0.1, 10.x.x.x) can never match a domain suffix,
// so it is rejected. Keep this list tight.
const ALLOWED_HOST_SUFFIXES = [
  "cdn.shopify.com",
  "myshopify.com",
  "res.cloudinary.com",
  "cloudinary.com",
];

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

function allowedHostSuffixes(): string[] {
  const suffixes = [...ALLOWED_HOST_SUFFIXES];
  // Allow the configured R2 public bucket host, if any.
  const r2 = getEnv().R2_PUBLIC_URL;
  if (r2) {
    try {
      suffixes.push(new URL(r2).hostname.toLowerCase());
    } catch {
      /* ignore malformed env */
    }
  }
  return suffixes;
}

function isAllowedImageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  return allowedHostSuffixes().some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
}

export async function GET(request: Request) {
  // Defense-in-depth (the proxy already gates this route behind auth).
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;

  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get("url");

  if (!imageUrl) {
    return new NextResponse("Missing url parameter", { status: 400 });
  }

  if (!isAllowedImageUrl(imageUrl)) {
    return new NextResponse("URL not allowed", { status: 400 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstream = await fetch(imageUrl, {
      signal: controller.signal,
      redirect: "follow",
    });

    if (!upstream.ok) {
      return new NextResponse("Failed to fetch image from source", {
        status: 502,
      });
    }

    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      return new NextResponse("Unsupported content type", { status: 415 });
    }

    const declaredLength = Number(upstream.headers.get("content-length") || "0");
    if (declaredLength && declaredLength > MAX_BYTES) {
      return new NextResponse("Image too large", { status: 413 });
    }

    const buffer = await upstream.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      return new NextResponse("Image too large", { status: 413 });
    }

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": getEnv().NEXT_PUBLIC_APP_URL,
      },
    });
  } catch (error) {
    console.error("[media-proxy] fetch error", error);
    return new NextResponse("Failed to fetch image", { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
