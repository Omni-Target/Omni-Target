import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api/require-user";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { getBriefVersions, getCampaignById, queryUserIntegrationSelect, saveRecoveredCreativeHooks } from "@/lib/db";
import { generateCreativeHooksOnly } from "@/lib/insights-engine";
import type { StoreData, StoreProduct } from "@/lib/store-data";

export const runtime = "nodejs";
export const maxDuration = 60;

interface GenerateTargetingRequestBody {
  productName: string;
  productDescription?: string;
  productPrice?: string | number | null;
  productVariants?: string | null;
  angleUsed?: string | null;
  campaignId?: string | null;
  versionId?: string | null;
}

export async function POST(request: Request) {
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;
  const { userId } = authResult;

  const limited = await enforceRateLimit({
    action: "campaigns:targeting",
    identifier: userId,
    limit: 30,
    windowSeconds: 3600,
  });
  if (!limited.ok) return limited.response;

  try {
    const body: GenerateTargetingRequestBody = await request.json().catch(() => ({}));
    const {
      productName,
      productDescription,
      productPrice,
      angleUsed,
    } = body;

    if (!productName) {
      return NextResponse.json(
        { error: "productName is required" },
        { status: 400 }
      );
    }

    if (Boolean(body.campaignId) !== Boolean(body.versionId)) {
      return NextResponse.json({ error: "Campaign and version are required together." }, { status: 400 });
    }
    let savedProductDescription: string | null = null;
    let savedProductPrice: string | number | null = null;
    if (body.campaignId && body.versionId) {
      const campaign = await getCampaignById(userId, body.campaignId);
      const versions = campaign ? await getBriefVersions(userId, body.campaignId) : [];
      if (!campaign || !versions.some((version) => version.id === body.versionId)) {
        return NextResponse.json({ error: "Brief version not found." }, { status: 404 });
      }
      if (campaign.product_name?.trim().toLowerCase() !== productName.trim().toLowerCase()) {
        return NextResponse.json({ error: "Product does not match this brief." }, { status: 400 });
      }
      savedProductDescription = campaign.product_description;
      savedProductPrice = campaign.product_price;
    }

    const integration = await queryUserIntegrationSelect(
      userId!,
      "store_snapshot"
    );
    const storeSnapshot = integration?.store_snapshot as StoreData | undefined;

    if (!storeSnapshot) {
      return NextResponse.json(
        { error: "No store data available. Sync your store first." },
        { status: 400 }
      );
    }

    const storeProducts = (storeSnapshot.products || []) as StoreProduct[];
    const matchedProduct = storeProducts.find(
      (p) =>
        p.name.trim().toLowerCase() === productName.trim().toLowerCase() ||
        (p.id && String(p.id) === String(productName))
    );

    const storeAov = storeSnapshot.orders?.average_order_value || 50;
    const parsedPrice =
      typeof (savedProductPrice ?? productPrice) === "number"
        ? Number(savedProductPrice ?? productPrice)
        : parseFloat(String(savedProductPrice ?? productPrice ?? "0").replace(/[^0-9.]/g, "")) ||
          matchedProduct?.price ||
          Math.round(storeAov);

    const targetProductOverride: StoreProduct = {
      ...(matchedProduct || {}),
      id: matchedProduct?.id || "selected-product",
      name: productName,
      description: savedProductDescription || productDescription || matchedProduct?.description || "",
      price: parsedPrice,
      units_sold: matchedProduct?.units_sold || 0,
      revenue: matchedProduct?.revenue || 0,
      in_stock: matchedProduct?.in_stock ?? true,
      collection:
        matchedProduct?.collection || matchedProduct?.product_type || "",
      image_url: matchedProduct?.image_url || "",
      should_advertise: true,
      tags:
        matchedProduct?.tags && matchedProduct.tags.length > 0
          ? matchedProduct.tags
          : [],
      product_type:
        matchedProduct?.product_type ||
        matchedProduct?.collection ||
        "",
      has_partial_stock: matchedProduct?.has_partial_stock ?? false,
      in_stock_variant_count: matchedProduct?.in_stock_variant_count || 1,
      total_variant_count: matchedProduct?.total_variant_count || 1,
    };

    const cleanAngleUsed =
      typeof angleUsed === "string" ? angleUsed.trim() || null : null;

    const creativeHooks = await generateCreativeHooksOnly(
      storeSnapshot, targetProductOverride, cleanAngleUsed, userId
    );
    if (body.campaignId && body.versionId) {
      await saveRecoveredCreativeHooks(userId, body.campaignId, body.versionId, creativeHooks);
    }

    return NextResponse.json({
      success: true,
      creative_hooks: creativeHooks,
    });
  } catch (error) {
    console.error("[/api/campaigns/generate/targeting] Error:", error);
    return NextResponse.json(
      {
        error: "Creative hooks could not be generated. Your ad copy is safe; retry hooks only.",
      },
      { status: 502 }
    );
  }
}
