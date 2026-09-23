import { requireUser } from "@/lib/api/require-user";
import { fetchSafeImage, isAllowedImageUrl } from "@/lib/safe-image-fetch";

export async function GET(request: Request) {
  const authResult = await requireUser();
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
