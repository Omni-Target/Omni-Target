import { NextResponse } from "next/server";
import { Anthropic } from "@anthropic-ai/sdk";
import { requireUser } from "@/lib/api/require-user";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { queryUserIntegrationSelect, updateUserIntegration, insertCreditUsage, logApiUsage, insertCampaign, insertBriefVersion, getBriefVersions } from "@/lib/db";
import sharp from "sharp";
import { generateTargetingProfile } from "@/lib/insights-engine";
import { getAdvantagePlusGuidance } from "@/lib/advantage-plus";
import type { StoreProduct } from "@/lib/store-data";

import { detectColumns } from "@/lib/billing-db";

// Credit-gating: check balance before generation

// Global client removed in favor of explicit initialization per request

/**
 * Expected request body for the generation API
 */
interface GenerateRequest {
  brandName: string;
  productName: string;
  productDescription: string;
  targetAudience?: string;
  campaignGoal?: string;
  tonePreference?: string;
  mediaUrl?: string | null; // TODO: Pass to preview step
  imageUrl?: string | null;
  productPrice?: string | null;
  platform?: string; // TODO: Adjust copy length and format based on platform selection
  dailyBudget?: string;
  duration?: string;
  locations?: string[];
  productVariants?: string | null;
  gatewayInsight?: GatewayInsight | null;
  storeDataForApi?: unknown;
  storeAov?: number | null;
  storePrices?: number[];
  isNewLaunch?: boolean;
  isRegeneration?: boolean;
  shopifyStoreCountry?: string | null;
  topCustomerLocations?: CustomerLocation[] | null;
  // Present on regenerations: attaches the new attempt to the existing brief
  // session instead of creating a fresh campaign.
  campaignId?: string | null;
}

interface GatewayInsight {
  storeAov?: number;
  currentProductClassification?: string;
  currentProductVelocity?: number;
  storeMedianVelocity?: number;
  currentProductRepeatRate?: number;
}

interface CustomerLocation {
  city?: string;
  province?: string;
  country?: string;
}

export const COPYWRITER_SYSTEM_PROMPT = `You are a world-class senior direct-response performance copywriter who writes exceptionally high-converting Meta ad copy for high-growth e-commerce brands.

You understand that great ads are punchy, direct, visually grounded, and focused relentlessly on the product's unique value — whether that is an emotional transformation, status elevation, or practical utility.

Before generating copy, you silently analyze market dynamics, buyer psychology, and consideration tiers. You never expose this internal reasoning in your output; you output exclusively clean, parseable JSON conforming to the requested schema.

═══════════════════════════════════════════════════════════════════
PILLAR 1: DYNAMIC MARKET AND CONSIDERATION TIER REASONING
═══════════════════════════════════════════════════════════════════
You will receive key store context in the user prompt:
- Store Primary Country: shopify_store_country
- Top Customer Locations: top_customer_locations
- Product Price: product_price
- Store AOV: store_aov
- Store Currency: store_currency

Silently evaluate:
1. Primary Market Identification:
   Infer the store's primary geographic focus from the country and customer locations.
2. Consideration & Purchasing Power Calibration:
   Evaluate the product price against the store AOV AND against real-world consumer purchasing power in that specific market.
   Remember: A product priced below store AOV can still represent a high-consideration, discerning purchase depending on regional economic context (e.g. comparing Lagos vs. London vs. New York purchasing dynamics). Never rely solely on mathematical price ratios; ground your reasoning in how a real customer in that market perceives the expenditure.
3. Classification into 3 Distinct Tiers:
   - Luxury: High consideration, investment mindset, elite craftsmanship, exclusive aesthetic.
   - Premium Contemporary: Aspirational yet accessible, design-led, high-quality daily rotation, style-conscious.
   - Mid-Market: Practical value, immediate lifestyle utility, low-friction adoption, broad accessibility.
4. The Four Cultural Pillars:
   - Communication Style: How top-tier indigenous and global luxury brands in this market speak (e.g. quiet confidence vs. expressive energy).
   - Buyer Psychology: What triggers purchase: directness vs. restraint, aspiration vs. belonging, tactile craftsmanship vs. visible status.
   - Regional Luxury Definition: How luxury is experienced locally: quiet vs. bold, occasion-driven vs. everyday elevation.
   - Brand Taboos: What immediately cheapens the brand in this market: pushy discount language, exaggerated hype, desperation, or off-brand claims.

═══════════════════════════════════════════════════════════════════
PILLAR 2: REGIONAL NUANCE & MARKET FALLBACKS
═══════════════════════════════════════════════════════════════════
When regional signals are clear, tailor nuance accordingly:
- Nigeria (NG): Quiet confidence, appreciation for bespoke tailoring, craft, prestige, and fabric quality. Investment-justified rather than bargain-seeking.
- United Kingdom (GB): Understated elegance, dry wit or quiet restraint, minimal clutter, heritage, and timeless durability.
- United Arab Emirates (AE): Polished opulence, occasion-driven, status-aware — honoring both regional Emirati sophistication and cosmopolitan international tastes.
- United States (US): Identity-first, direct, aesthetic-led ("this is who you are"), immediate value proposition and seamless lifestyle integration.
- Canada (CA): Thoughtful, understated, quality-obsessed, weather/utility conscious, understated refinement.
- Australia (AU): Effortless confidence, relaxed luxury, sun/lifestyle-oriented, completely allergic to pretension or stiff formality.
- South Africa (ZA): Aspirational yet grounded, vibrant community awareness, occasion-led celebrations.
- France (FR): Effortless nonchalance, intellectual chic, artistic curation, never appearing to try too hard.
- Germany (DE): Functional perfection, architectural clarity, material integrity, rigorous truth in advertising.
- Singapore (SG): Sleek, hyper-polished, cosmopolitan efficiency, modern status signals.
- Kenya / Ghana (KE/GH): Bold, identity-proud, contemporary African luxury, rich cultural resonance.

═══════════════════════════════════════════════════════════════════
PILLAR 3: CAMPAIGN OBJECTIVE ADAPTATION
═══════════════════════════════════════════════════════════════════
Adapt copy structure strictly according to the campaign goal:
1. "Drive Website Sales" (Default Direct-Response):
   The copy must drive immediate consideration. The opening hooks attention, the body validates desire and overcomes friction, and the final line commands an effortless, confident action to visit and purchase.
2. "Grow Brand Awareness":
   Focus intensely on distinctive brand codes, unique design signatures, founder ethos, or material excellence. Build brand equity without desperate sales pitches.
3. "Promote a New Collection":
   Frame the ad around inaugural release, new seasonal drops, or first-look access. Ignite curiosity and desire without sounding frantic.
4. "Retarget Past Visitors":
   Speak directly to an audience that already knows the brand. Address hesitation, reaffirm the standout detail they noticed before, or highlight versatile styling to close the decision.

═══════════════════════════════════════════════════════════════════
PILLAR 4: UNIVERSAL COPYWRITING MANDATES & CONSTRAINTS
═══════════════════════════════════════════════════════════════════
1. The Luxury Restraint Rule:
   If the product is Luxury or Premium Contemporary, restraint ALWAYS wins over hype.
   - ABSOLUTE BAN on exclamation marks (!). Never use exclamation marks.
   - ABSOLUTE BAN on false urgency: No countdowns, no "Hurry!", no "Don't miss out!", no "Selling out fast!".
   - Build desire through precision, posture, and descriptive sensory power.
2. Creative Visual Grounding:
   - When an image is provided: Root the copy in visual truth — silhouette, texture, color tones, cut, and occasion mood.
   - When a video storyboard is provided: Write copy that complements motion, pacing, and dynamic on-screen transitions. Never refer to "this picture" or static imagery when a video storyboard is provided.
3. Sell the Outcome, Not the Specs:
   - Do not merely summarize the raw product description.
   - Pull 1 or 2 striking physical or material details to anchor credibility, then sell how wearing/using the product feels, transforms, or functions.
4. Ban on Abstract Clichés:
   - Never use: "There is a version of you...", "Imagine a world...", "Step into...", "Elevate your...", "Look no further...", "Game changer".
   - Avoid melodrama and poetic fluff. Specificity always beats generalities.
5. Compliance & Cleanliness:
   - NEVER include the product price or currency in the copy (Meta policy & pricing fluidity).
   - NEVER reference stock counts (e.g. "only 3 left") — stock goes stale and violates advertising policies.
   - NEVER assume the reader's geographic location or local currency.

═══════════════════════════════════════════════════════════════════
OUTPUT FORMAT SPECIFICATION
═══════════════════════════════════════════════════════════════════
Respond ONLY with a valid JSON object matching this exact structure:
{
  "headline": "Maximum 8 words. A bold statement or specific product detail. Never a question. Never abstract or clever for its own sake.",
  "primaryText": "2 to 3 punchy sentences. Sentence 1 hooks the moment or feeling. Sentence 2 grounds it in specific product details. Sentence 3 is an action or memorable truth.",
  "description": "1 sentence under 20 words. A specific physical detail that adds fresh information not repeated in the primary text.",
  "cta": "One of: Shop Now, Learn More, Order Now, Get Offer, Sign Up, Book Now, Contact Us",
}`;

/**
 * POST handler for generating ad copy via Claude
 * @param request The incoming HTTP request containing campaign form data
 * @returns JSON response with AI-generated ad creatives or an error object
 */
export async function POST(request: Request) {
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;
  const { userId } = authResult;

  // AI generation is the most expensive endpoint (Anthropic + image processing).
  const limited = await enforceRateLimit({
    action: "campaigns:generate",
    identifier: userId,
    limit: 20,
    windowSeconds: 3600,
  });
  if (!limited.ok) return limited.response;

  const cols = await detectColumns();
  const selectQuery = [
    "store_snapshot",
    cols.hasCredits ? "credits" : "credits_balance",
    "credits_balance",
    "credits_unlimited_until"
  ].join(", ");

  const integration = await queryUserIntegrationSelect(userId!, selectQuery);

  // Credit gate: check if user has credits or unlimited access
  const hasUnlimited =
    integration?.credits_unlimited_until &&
    new Date(integration.credits_unlimited_until) > new Date();

  const currentCredits = integration
    ? (cols.hasCredits ? integration.credits : integration.credits_balance) ?? integration.credits_balance ?? 0
    : 0;

  const hasCredits = currentCredits > 0;

  try {
    const body: Partial<GenerateRequest> = await request.json();

    // Extract isRegeneration early — regenerations bypass the credit gate entirely.
    const isRegeneration = body.isRegeneration ?? false;

    // Credit gate: block only if user has no credits AND it's not a free regeneration
    if (!hasUnlimited && !hasCredits && !isRegeneration) {
      return NextResponse.json({
        error: "no_credits",
        message: "You have no briefs remaining. Purchase a pack to continue.",
        redirect: "/pricing"
      }, { status: 402 });
    }

    const {
      brandName,
      productName,
      productDescription,
      targetAudience = "Broad",
      campaignGoal = "Drive Website Sales",
      tonePreference = "Let AI decide",
      imageUrl,
      productPrice,
      platform,
      productVariants,
      gatewayInsight,
      storeAov,
      isNewLaunch,
      shopifyStoreCountry,
      topCustomerLocations,
    } = body;

    const currency = integration?.store_snapshot?.store?.currency || "USD";

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Anthropic API key not configured" },
        { status: 500 }
      );
    }
    const client = new Anthropic({ apiKey });

    // Validate required fields
    if (!brandName || !productName || !productDescription) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    console.log("Selected platform:", platform);



    // Detect if the media is a video:
    // 1. Check Cloudinary URL path for /video/upload/
    // 2. Fallback to file extension check
    const isVideo = imageUrl 
      ? (imageUrl.includes("/video/upload/") || /\.(mp4|mov|webm)(\?|$)/i.test(imageUrl))
      : false;
    
    console.log("Media analysis:", { 
      imageUrl: imageUrl?.slice(0, 80), 
      isVideo, 
      hasUploadPath: imageUrl?.includes("/upload/") 
    });

    const formattedLocations = Array.isArray(topCustomerLocations)
      ? topCustomerLocations.map((l) => `${l.city || l.province || ""}${l.country ? ` (${l.country})` : ""}`).filter(Boolean).join(", ")
      : "Unknown";

    const textContent = 
`Generate Meta ad copy for:

Brand: ${brandName}
Product: ${productName}
Description: ${productDescription}

Store Primary Country: ${shopifyStoreCountry || "Unknown"}
Top Customer Locations: ${formattedLocations}
Product Price: ${productPrice || "Unknown"}
Store AOV: ${storeAov || "Unknown"}
Store Currency: ${currency}

Audience: ${targetAudience || "Not specified"}
Goal: ${campaignGoal}
Tone: ${tonePreference}
${productVariants ? `Available Variants/Sizes: ${productVariants}` : ""}

${isVideo ? 
  `CRITICAL: The ad creative is a VIDEO. 
  A 10-frame sequential storyboard of the video has been provided.
  Ensure the copy works perfectly alongside motion-heavy content. 
  Do not refer to "this picture" or static imagery.` 
  : imageUrl ? 
  `A product image has been provided. 
  Use what you observe — colour, style, 
  texture, mood, occasion-fit, aesthetic — 
  to inform the copy. Let the visual 
  truth of the product shape the writing 
  as much as the description does.` 
  : ""}
  
${productVariants ? 
  `CRITICAL: The available sizes/variants are limited to: ${productVariants}. 
  You MUST weave this limitation into the copy naturally. Do not sound apologetic. 
  Instead, use it to create scarcity or exclusivity (e.g. "Only available in ${productVariants}").`
  : ""}

${gatewayInsight?.currentProductClassification === "Gateway" ?
  `CRITICAL: This product is classified as a GATEWAY PRODUCT. It converts cold traffic extremely well.
  Your hook MUST be derived from its high velocity or repeat rate. 
  ${(gatewayInsight.currentProductVelocity ?? 0) > (gatewayInsight.storeMedianVelocity || 0) ? `Consider a hook like "Sells out every ${Math.max(1, Math.round(90 / (gatewayInsight.currentProductVelocity || 1)))} days".` : ""}
  ${(gatewayInsight.currentProductRepeatRate ?? 0) > 0.1 ? `Or a hook like "The ${productName} our customers come back for".` : ""}`
  : gatewayInsight?.currentProductClassification === "Consideration" ?
  `CRITICAL: This product is classified as a CONSIDERATION PRODUCT. It converts warm or returning traffic.
  Your hook MUST be derived from its premium attributes and the fact that it is a high-consideration purchase. Address the quality and investment value.`
  : ""}

${isNewLaunch ? `NEW LAUNCH BRIEF: This product has fewer than 3 orders — there is no purchase history to reference.
  CRITICAL for New Launches:
  - Frame this as a first look or early access moment — not a proven bestseller.
  - NEVER use social proof phrases like "loved by thousands", "our best-seller", or "customers say".
  - NEVER use scarcity tactics like "selling fast" or "only X left" — there is no history to back this up.
  - Recommended angles: UGC-style discovery, founder introduction, early adopter framing ("Be the first", "Before everyone else").
  - Write copy that builds desire and curiosity rather than urgency or proof.
  - Use the product's design, materials, and category to sell the vision, not the track record.` : ""}`;

    const messageContent: Anthropic.ContentBlockParam[] = [];

    // Max base64 size we'll send to Anthropic (4.5 MB leaves headroom under the 5 MB API limit)
    const MAX_BASE64_BYTES = 4_500_000;

    // Helper to fetch an image URL and convert to base64 with automatic resizing
    const fetchImageBase64 = async (url: string) => {
      try {
        let fetchUrl = url;

        // --- Shopify CDN: resize to 1200px wide + force JPEG via query params without breaking file hashes ---
        if (fetchUrl.includes("cdn.shopify.com")) {
          try {
            const parsed = new URL(fetchUrl);
            parsed.searchParams.set("width", "1200");
            parsed.searchParams.set("format", "jpg");
            fetchUrl = parsed.toString();
          } catch {
            fetchUrl = url;
          }
        }

        // --- Cloudinary: add quality + resize transforms ---
        if (fetchUrl.includes("res.cloudinary.com") && fetchUrl.includes("/upload/")) {
          const uploadIdx = fetchUrl.indexOf("/upload/");
          const base = fetchUrl.slice(0, uploadIdx + 8); // includes "/upload/"
          const rest = fetchUrl.slice(uploadIdx + 8);
          // Prepend resize + quality transforms (won't clash with existing transforms)
          fetchUrl = `${base}w_1200,c_limit,q_auto:good,f_jpg/${rest}`;
        }

        console.log("Fetching image for AI (URL):", fetchUrl.slice(0, 120));

        let res = await fetch(fetchUrl);
        // If resized CDN URL failed (e.g. 404 or CDN rejection), fallback to the original raw URL
        if (!res.ok && fetchUrl !== url) {
          console.warn(`Resized image URL returned ${res.status} ${res.statusText}, retrying with original URL: ${url}`);
          res = await fetch(url);
        }
        if (!res.ok) throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`);

        const buffer = await res.arrayBuffer();
        let contentType = (res.headers.get("content-type") || "image/jpeg")
          .split(";")[0]
          .trim()
          .toLowerCase();

        // Map common variations
        if (contentType === "image/jpg") contentType = "image/jpeg";

        const supported = ["image/jpeg", "image/png", "image/gif", "image/webp"];

        let imgBuffer: Uint8Array = Buffer.from(buffer);

        // If the CDN returned an unsupported type (like avif, tiff, heic), convert to jpeg with sharp
        if (!supported.includes(contentType)) {
          try {
            console.info(`Converting image from ${contentType} to image/jpeg using sharp...`);
            imgBuffer = await sharp(imgBuffer)
              .resize({ width: 1200, withoutEnlargement: true })
              .jpeg({ quality: 80, mozjpeg: true })
              .toBuffer();
            contentType = "image/jpeg";
          } catch (convErr) {
            console.warn(`Failed to convert image type ${contentType} with sharp:`, convErr);
            return null;
          }
        }

        // Progressive compression: if still over limit, use sharp to shrink until it fits.
        // This guarantees visual analysis always works — we never skip the image.
        const compressionSteps = [
          { width: 1200, quality: 80 },
          { width: 1200, quality: 60 },
          { width: 1000, quality: 50 },
          { width: 800,  quality: 40 },
        ];

        let base64 = Buffer.from(imgBuffer).toString("base64");

        if (base64.length > MAX_BASE64_BYTES) {
          console.info(
            `Image too large (${(base64.length / 1_000_000).toFixed(1)} MB base64). Compressing with sharp...`
          );

          for (const step of compressionSteps) {
            imgBuffer = await sharp(imgBuffer)
              .resize({ width: step.width, withoutEnlargement: true })
              .jpeg({ quality: step.quality, mozjpeg: true })
              .toBuffer();

            base64 = Buffer.from(imgBuffer).toString("base64");
            contentType = "image/jpeg";

            console.info(
              `  → ${step.width}px @ q${step.quality}: ${(base64.length / 1_000_000).toFixed(2)} MB`
            );

            if (base64.length <= MAX_BASE64_BYTES) break;
          }
        }

        return {
          base64,
          mediaType: contentType as "image/jpeg" | "image/png" | "image/gif" | "image/webp"
        };
      } catch (err) {
        console.error("Error fetching image for AI:", err);
        return null;
      }
    };

    // Anthropic API only accepts base64 image blocks, not raw URLs
    if (imageUrl && !isVideo) {
      const imgData = await fetchImageBase64(imageUrl);
      if (imgData) {
        messageContent.push({
          type: "image",
          source: {
            type: "base64",
            media_type: imgData.mediaType as
              | "image/jpeg"
              | "image/png"
              | "image/gif"
              | "image/webp",
            data: imgData.base64,
          }
        });
      }
    } else if (imageUrl && isVideo) {
      // It's a video on Cloudinary. Generate a 10-frame storyboard.
      const storyboardFrames = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
      
      const framePromises = storyboardFrames.map(async (percent) => {
        const uploadIdx = imageUrl.indexOf("/upload/");
        if (uploadIdx !== -1) {
          const base = imageUrl.slice(0, uploadIdx + 8); // includes "/upload/"
          const rest = imageUrl.slice(uploadIdx + 8);
          // Replace video extension with .jpg for image output
          const restAsJpg = rest.replace(/\.(mp4|mov|webm|avi)$/i, ".jpg");
          // Insert Cloudinary transformation: start offset percent
          const frameUrl = `${base}so_${percent}p/${restAsJpg}`;
          
          console.log(`Fetching storyboard frame ${percent}%:`, frameUrl);
          
          const imgData = await fetchImageBase64(frameUrl);
          if (imgData) {
            return {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: imgData.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: imgData.base64,
              }
            };
          }
        }
        return null;
      });

      const resolvedFrames = (await Promise.all(framePromises)).filter(
        (f): f is NonNullable<typeof f> => f !== null
      );
      messageContent.push(...resolvedFrames);
    }

    messageContent.push({
      type: "text",
      text: textContent,
    });

    // Resolve matching StoreProduct or construct targetProductOverride for strict single-SKU isolation
    const storeProducts = (integration?.store_snapshot?.products || []) as StoreProduct[];
    const matchedProduct = storeProducts.find(
      (p) =>
        p.name.trim().toLowerCase() === productName.trim().toLowerCase() ||
        (p.id && String(p.id) === String(productName))
    );

    const parsedPrice =
      typeof productPrice === "number"
        ? productPrice
        : parseFloat(String(productPrice || "0").replace(/[^0-9.]/g, "")) ||
          matchedProduct?.price ||
          Math.round(storeAov || 50);

    const targetProductOverride: StoreProduct = {
      ...(matchedProduct || {}),
      id: matchedProduct?.id || "selected-product",
      name: productName,
      description: productDescription || matchedProduct?.description || "",
      price: parsedPrice,
      units_sold: matchedProduct?.units_sold || 0,
      revenue: matchedProduct?.revenue || 0,
      in_stock: matchedProduct?.in_stock ?? true,
      collection: matchedProduct?.collection || matchedProduct?.product_type || "Apparel",
      image_url: imageUrl || matchedProduct?.image_url || "",
      should_advertise: true,
      tags: matchedProduct?.tags && matchedProduct.tags.length > 0 ? matchedProduct.tags : [],
      product_type: matchedProduct?.product_type || matchedProduct?.collection || "Apparel",
      has_partial_stock: matchedProduct?.has_partial_stock ?? false,
      in_stock_variant_count: matchedProduct?.in_stock_variant_count || 1,
      total_variant_count: matchedProduct?.total_variant_count || 1,
    };

    const targetingProfilePromise = integration?.store_snapshot
      ? generateTargetingProfile(
          integration.store_snapshot,
          1,
          50,
          userId,
          targetProductOverride
        ).catch((profileErr) => {
          console.error("Targeting profile generation error:", profileErr);
          return null;
        })
      : Promise.resolve(null);

    // Call Anthropic API concurrently for ad copy and single-SKU Advantage+ targeting profile
    const [message, targetingProfile] = await Promise.all([
      client.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        system: [
          {
            type: "text",
            text: COPYWRITER_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: messageContent }],
      }),
      targetingProfilePromise,
    ]);

    if (userId) {
      logApiUsage(
        userId,
        "brief_generation",
        message.usage.input_tokens,
        message.usage.output_tokens
      );
    }

    console.log("[Anthropic Prompt Caching - Copy Generation]", {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      cache_creation_input_tokens:
        (message.usage as unknown as { cache_creation_input_tokens?: number })
          .cache_creation_input_tokens ?? 0,
      cache_read_input_tokens:
        (message.usage as unknown as { cache_read_input_tokens?: number })
          .cache_read_input_tokens ?? 0,
    });

    // Check if we received text content
    const responseBlock = message.content.find((block) => block.type === "text");
    if (!responseBlock || responseBlock.type !== "text") {
      throw new Error("No text content returned from Claude");
    }

    let parsedResponse;
    try {
      let cleaned = responseBlock.text.trim();
      const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (jsonMatch) {
        cleaned = jsonMatch[1].trim();
      } else {
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
          cleaned = cleaned.substring(start, end + 1);
        }
      }
      parsedResponse = JSON.parse(cleaned);
    } catch (parseError) {
      console.error("JSON Parsing Error:", parseError);
      return NextResponse.json(
        { error: "Copy generation failed. Try again." },
        { status: 500 }
      );
    }

    // Deduct credit after successful generation, ONLY if it's not a free regeneration
    if (!hasUnlimited && !isRegeneration) {
      const newCredits = Math.max(0, currentCredits - 1);
      const updateData: Record<string, unknown> = {};
      if (cols.hasCredits) {
        updateData.credits = newCredits;
      }
      updateData.credits_balance = newCredits;

      await updateUserIntegration(userId!, updateData);
      await insertCreditUsage(userId!, 1, "brief_generated");

      if (newCredits === 1 || newCredits === 0) {
        try {
          const { clerkClient } = await import("@clerk/nextjs/server");
          const user = await (await clerkClient()).users.getUser(userId!);
          const email = user.emailAddresses[0]?.emailAddress;
          
          if (email) {
            const { sendEmail } = await import("@/lib/email");
            
            if (newCredits === 1) {
              const { creditLowEmailHtml } = await import("@/emails/credit-low");
              await sendEmail({
                to: email,
                subject: "1 brief credit left",
                html: creditLowEmailHtml(),
                userId: userId!,
                templateName: "credit-low"
              });
            } else if (newCredits === 0) {
              const { creditExhaustedEmailHtml } = await import("@/emails/credit-exhausted");
              await sendEmail({
                to: email,
                subject: "You've used all your credits",
                html: creditExhaustedEmailHtml(),
                userId: userId!,
                templateName: "credit-exhausted"
              });
            }
          }
        } catch (emailErr) {
          console.error("Failed to send credit alert email:", emailErr);
        }
      }
    }

    // Persist the brief so it survives refresh, lives at a stable URL, and keeps
    // every regeneration attempt for later comparison/history. Best-effort: a
    // persistence failure must never break generation, so errors are swallowed
    // and we simply return without ids (the client falls back to the in-app view).
    const copyFields = {
      headline: parsedResponse.headline ?? null,
      primary_text: parsedResponse.primaryText ?? null,
      description: parsedResponse.description ?? null,
      cta: parsedResponse.cta ?? null,
      copywriter_note: parsedResponse.copywriterNote ?? null,
    };
    let campaignId: string | null = body.campaignId ?? null;
    let versionId: string | null = null;
    let attemptNumber = 1;
    try {
      if (campaignId) {
        // Regeneration attaching to an existing session: append the next attempt.
        // getBriefVersions is owner-scoped, so a spoofed id resolves to [] and we
        // safely fall through to creating a fresh campaign.
        const versions = await getBriefVersions(userId!, campaignId);
        if (versions.length === 0) {
          campaignId = null;
        } else {
          attemptNumber = versions.length + 1;
        }
      }
      if (!campaignId) {
        campaignId = await insertCampaign(userId!, {
          brand_name: brandName ?? null,
          product_name: productName ?? null,
          product_description: productDescription ?? null,
          target_audience: targetAudience ?? null,
          campaign_goal: campaignGoal ?? null,
          tone_preference: tonePreference ?? null,
          platform: platform ?? null,
          media_url: body.mediaUrl ?? imageUrl ?? null,
          product_price: productPrice ?? null,
          ...copyFields,
        });
        attemptNumber = 1;
      }
      if (campaignId) {
        versionId = await insertBriefVersion(userId!, campaignId, {
          attempt_number: attemptNumber,
          is_selected: attemptNumber === 1,
          ...copyFields,
        });
      }
    } catch (persistErr) {
      console.error("Brief persistence failed (continuing):", persistErr);
      campaignId = null;
      versionId = null;
    }

    // Balance after this request. Deduction above runs only for the first,
    // non-unlimited generation; regenerations and unlimited users are unchanged.
    // Returned so the client can update the shared credits cache instantly
    // instead of waiting for a refetch.
    const creditsBalanceAfter =
      !hasUnlimited && !isRegeneration
        ? Math.max(0, currentCredits - 1)
        : currentCredits;

    const monthlyOrders =
      integration?.store_snapshot?.orders?.orders_last_30_days ||
      integration?.store_snapshot?.orders?.order_count ||
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
            seed_interests: targetingProfile.seed_interests || ["Online Shopping"],
          },
        }
      : null;

    // ── Diagnostic logging: trace what the targeting profile returned ──
    console.log("[GENERATE] targetProductOverride.name:", targetProductOverride.name);
    console.log("[GENERATE] targetProductOverride.description:", targetProductOverride.description?.slice(0, 80));
    console.log("[GENERATE] targetingProfile is null?", targetingProfile === null);
    if (targetingProfile) {
      console.log("[GENERATE] targetingProfile.creative_hooks count:", targetingProfile.creative_hooks?.length);
      console.log("[GENERATE] targetingProfile.demographics.gender:", targetingProfile.demographics?.gender);
      console.log("[GENERATE] hook[0] angle:", targetingProfile.creative_hooks?.[0]?.angle);
      console.log("[GENERATE] hook[0] visual_cue (first 80 chars):", targetingProfile.creative_hooks?.[0]?.visual_cue?.slice(0, 80));
    }

    // Return the parsed copy, the authoritative balance, and the single-SKU targeting profile.
    return NextResponse.json(
      {
        ...parsedResponse,
        creative_hooks: targetingProfile?.creative_hooks || null,
        advantage_plus_guidance: advantagePlusGuidance,
        targeting_profile: targetingProfile,
        credits_balance: creditsBalanceAfter,
        is_unlimited: !!hasUnlimited,
        campaignId,
        versionId,
        attemptNumber,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Campaign API Generation Error:", error);

    // Map known Anthropic error types to user-friendly messages
    const err = error as { status?: number; message?: string };
    const message =
      err?.status === 400 && err?.message?.includes("image")
        ? "Product image could not be processed. Try a different image or generate without one."
        : err?.status === 429
          ? "AI is temporarily busy. Please try again in a moment."
          : "Something went wrong generating your brief. Please try again.";

    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
