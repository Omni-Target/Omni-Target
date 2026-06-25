import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const imageUrl = searchParams.get("url");

    if (!imageUrl) {
      return new NextResponse("Missing url parameter", { status: 400 });
    }

    // Server-to-server fetch bypasses client CORS limits
    const response = await fetch(imageUrl);
    if (!response.ok) {
      return new NextResponse("Failed to fetch image from source", { status: response.status });
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const buffer = await response.arrayBuffer();

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400", // cache for a day
        "Access-Control-Allow-Origin": "*", // permissive for pdf generation
      },
    });
  } catch (error) {
    console.error("Proxy image error:", error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
