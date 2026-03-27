import { resolveShopifyDomain } from "@/lib/shopify-resolver";

export async function POST(request: Request) {
  const { domain } = await request.json();
  
  if (!domain) {
    return Response.json(
      { error: "Domain required" },
      { status: 400 }
    );
  }

  const result = await resolveShopifyDomain(domain);
  return Response.json(result);
}
