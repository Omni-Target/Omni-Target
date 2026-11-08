import { requireUser } from "@/lib/api/require-user";
import { fetchSafeImage, isAllowedImageUrl } from "@/lib/safe-image-fetch";
import { logDeprecatedEndpointHit } from "@/lib/api/retired-endpoint";

export async function GET(request: Request) {
  const authResult = await requireUser();
  // SEC-08: no known caller; observed before removal (S2.4).
  logDeprecatedEndpointHit("/api/media/proxy", request, authResult.ok ? authResult.userId : null);
  if (!authResult.ok) return authResult.response;
  const url = new URL(request.url).searchParams.get("url");
  if (!url || !isAllowedImageUrl(url)) return new Response("URL not allowed", { status: 400 });
  try {
    const response = await fetchSafeImage(url);
    response.headers.set("Cache-Control", "private, max-age=3600");
    return response;
  } catch {
    return new Response("Unable to fetch image", { status: 502 });
  }
}
