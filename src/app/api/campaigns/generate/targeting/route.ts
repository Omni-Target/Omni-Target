import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api/require-user";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { queryUserIntegrationSelect } from "@/lib/db";
import { generateTargetingProfile } from "@/lib/insights-engine";
import { getAdvantagePlusGuidance } from "@/lib/advantage-plus";
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
      typeof productPrice === "number"
        ? productPrice
        : parseFloat(String(productPrice || "0").replace(/[^0-9.]/g, "")) ||
          matchedProduct?.price ||
          Math.round(storeAov);

    const targetProductOverride: StoreProduct = {
      ...(matchedProduct || {}),
      id: matchedProduct?.id || "selected-product",
      name: productName,
      description: productDescription || matchedProduct?.description || "",
      price: parsedPrice,
      units_sold: matchedProduct?.units_sold || 0,
      revenue: matchedProduct?.revenue || 0,
      in_stock: matchedProduct?.in_stock ?? true,
      collection:
        matchedProduct?.collection || matchedProduct?.product_type || "Apparel",
      image_url: matchedProduct?.image_url || "",
      should_advertise: true,
      tags:
        matchedProduct?.tags && matchedProduct.tags.length > 0
          ? matchedProduct.tags
          : [],
      product_type:
        matchedProduct?.product_type ||
        matchedProduct?.collection ||
        "Apparel",
      has_partial_stock: matchedProduct?.has_partial_stock ?? false,
      in_stock_variant_count: matchedProduct?.in_stock_variant_count || 1,
      total_variant_count: matchedProduct?.total_variant_count || 1,
    };

    const cleanAngleUsed =
      typeof angleUsed === "string" ? angleUsed.trim() || null : null;

    const targetingProfile = await generateTargetingProfile(
      storeSnapshot,
      1,
      50,
      userId,
      targetProductOverride,
      cleanAngleUsed
    );

    const monthlyOrders =
      storeSnapshot.orders?.orders_last_30_days ||
      storeSnapshot.orders?.order_count ||
      0;
    const guidance = getAdvantagePlusGuidance(monthlyOrders);

    const advantagePlusGuidance = targetingProfile
      ? {
          campaign_type: guidance.campaign_type,
          optimization_event: guidance.optimization_event,
          optimization_reasoning:
            targetingProfile.optimization_reasoning || guidance.default_reasoning,
          seed_audience_suggestions: {
            age_min: targetingProfile.demographics?.age_min || 25,
            age_max: targetingProfile.demographics?.age_max || 44,
            gender: targetingProfile.demographics?.gender || "All",
            demographic_justification:
              targetingProfile.demographics?.demographic_justification ||
              "Demographic profile aligned with product price point and buyer history.",
            seed_interests: targetingProfile.seed_interests || [
              "Online Shopping",
            ],
          },
        }
      : null;

    return NextResponse.json({
      success: true,
      creative_hooks: targetingProfile?.creative_hooks || null,
      advantage_plus_guidance: advantagePlusGuidance,
      targeting_profile: targetingProfile,
    });
  } catch (error) {
    console.error("[/api/campaigns/generate/targeting] Error:", error);
    return NextResponse.json(
      {
        error: "Failed to generate targeting and creative hooks",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
