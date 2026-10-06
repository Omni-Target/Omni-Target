import { fetchSafeImage } from "@/lib/safe-image-fetch";
import { createHash, randomUUID } from "node:crypto";
import { buildGenerationContext } from "@/lib/campaigns/insights";
import { normalizeCopyPunctuation, validateCopy } from "@/lib/campaigns/validate-copy";
import { buildCopyValidationEvidence } from "@/lib/campaigns/copy-evidence";
import { NextResponse } from "next/server";
import { Anthropic } from "@anthropic-ai/sdk";
import { requireUser } from "@/lib/api/require-user";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { queryUserIntegrationSelect, logApiUsage, getBriefVersions, getCampaignById, getGenerationReceipt, isBriefRegenerationCommitReady, commitBriefGeneration } from "@/lib/db";
import sharp from "sharp";
import {
  CreativeHookGenerationError,
  generateRecommendations,
} from "@/lib/insights-engine";
import type { MetaRecommendations } from "@/lib/insights-engine";
import { reusableRecommendationsFromVersions } from "@/lib/campaigns/reuse-insights";
import { canonicalRegenerationProduct } from "@/lib/campaigns/regeneration-product";
import type { StoreProduct } from "@/lib/store-data";

import { detectColumns } from "@/lib/billing-db";
import { availableCredits } from "@/lib/credit-balance";
import { getChannelBehavioralGuidance, getGeographicBuyingDynamics } from "@/lib/campaigns/qualitative-guidance";
import { summarizeMarketingHistory } from "@/lib/marketing-evidence";

// Credit-gating: check balance before generation

export const runtime = "nodejs";
export const maxDuration = 180;

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
  skipTargeting?: boolean;
  // Present on regenerations: attaches the new attempt to the existing brief
  // session instead of creating a fresh campaign.
  campaignId?: string | null;
  requestId?: string;
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
PILLAR 3B: TONE & VOICE ADAPTATION
═══════════════════════════════════════════════════════════════════
Strictly calibrate cadence, rhythm, vocabulary, and sentence structure according to the requested Tone:
1. "Bold & Direct":
   - Fast velocity, punchy staccato rhythm. Keep sentences short, crisp, and rhythmic (often 3 to 7 words).
   - Lead immediately with the primary benefit, physical truth, or arresting outcome. Zero warm-up.
   - Assertive, decisive syntax. Ban passive hedging ("might", "could", "perhaps").
   - Command presence through brevity and punch rather than volume (still zero exclamation marks).
2. "Warm & Conversational":
   - Write like an insider friend or trusted advisor recommending their personal favorite.
   - Intimate, empathetic second-person perspective. Ground the product in relatable, lived moments (the morning rush, weekend rituals, unwinding at home).
   - Natural cadence that sounds spoken aloud, yet polished. Approachable and welcoming without sounding cheap or colloquial.
3. "Minimal & Editorial":
   - Curated architectural and editorial posture (clean, understated, intentional design aesthetic).
   - Sparse, deliberate wording. Maximum verbal whitespace. Let the product imagery carry the weight.
   - Focus intensely on design truth, form, materials, tactile structure, and precision finish.
   - Cool, effortless nonchalance. Never feels like it is trying to sell you anything.
4. "Premium & Aspirational":
   - High-status elevation, timeless heirloom mindset, and quiet luxury posture.
   - Celebrate heritage, meticulous craft, premium materials, and uncompromised quality integrity.
   - Speaks to discerning buyers who value longevity, performance, and distinction over loud hype.
5. "Let AI decide":
   - Silently select the voice that maximizes ROAS for this specific product's price tier and category:
     * Luxury & High-AOV products → Minimal & Editorial or Premium & Aspirational.
     * Practical utility & daily rotation products → Bold & Direct or Warm & Conversational.

═══════════════════════════════════════════════════════════════════
PILLAR 4: UNIVERSAL COPYWRITING MANDATES & CONSTRAINTS
═══════════════════════════════════════════════════════════════════
1. The Luxury Restraint Rule:
   If the product is Luxury or Premium Contemporary, restraint ALWAYS wins over hype.
   - ABSOLUTE BAN on exclamation marks (!). Never use exclamation marks.
   - ABSOLUTE BAN on false urgency or unverified demand claims: No countdowns, no "Hurry!", no "Don't miss out!", no "Selling out fast!", no "Keep selling out", no "Always sold out", no "Back by popular demand" unless verified store history explicitly documents repeated stockouts.
   - Build desire through precision, posture, and descriptive sensory power.
2. Creative Visual Grounding:
   - When an image is provided: Root the copy in visual truth — form, texture, color tones, materials, and real-world setting.
   - When a video storyboard is provided: Write copy that complements motion, pacing, and dynamic on-screen transitions. Never refer to "this picture" or static imagery when a video storyboard is provided.
3. Sell the Outcome, Not the Specs:
   - Do not merely summarize the raw product description.
   - Pull 1 or 2 striking physical or material details to anchor credibility, then sell how using, owning, or experiencing the product transforms daily life.
4. Ban on Abstract Clichés:
   - Never use: "There is a version of you...", "Imagine a world...", "Step into...", "Elevate your...", "Look no further...", "Game changer".
   - Never use passive announcement headlines: "Introducing...", "Meet the...", "The [Product] is here", "The [Product] arrives in [Color]". Every headline must be an active, arresting hook or sensory product truth.
   - Avoid melodrama and poetic fluff. Specificity always beats generalities.
5. Compliance & Cleanliness:
   - NEVER include the product price or currency in the copy (Meta policy & pricing fluidity).
   - NEVER reference stock counts (e.g. "only 3 left") — stock goes stale and violates advertising policies.
   - NEVER assume the reader's geographic location or local currency.
6. Grounded Material, Demand & Feature Truthfulness (Strict Zero-Hallucination Mandate):
   - ONLY reference physical materials (e.g. linen, silk, leather, titanium, ceramic, organic botanicals), closures/hardware (e.g. drawstring, zipper, magnetic, snap), or physical attributes that are EXPLICITLY documented in the product title, description, verified catalog tags/claims, or clearly visible in the product image.
   - NEVER invent or assume closures, components, mechanisms, or unstated ingredients.
   - NEVER invent unstated fabrics, materials, ingredients, or formulations.
   - For apparel products: NEVER claim an item is "unisex" unless documented. If womenswear, write with female styling nuance; if menswear, write with male nuance.
   - NEVER claim a product "fits every body" or "works for everyone" unless explicit universal specifications are documented in the product description.
   - NEVER make unverified demand claims like "why these keep selling out" or "our fastest-selling piece" — write from observed product craftsmanship, form, finish, and functional utility instead.

═══════════════════════════════════════════════════════════════════
PILLAR 5: CALL TO ACTION (CTA) & CONVERSION INTENT
═══════════════════════════════════════════════════════════════════
Meta Ads Manager strictly restricts the ad button to an official, fixed list. In Advantage+ Sales and direct-to-consumer e-commerce, the button must align with real purchase intent:
1. "Shop Now" (The Undisputed E-Commerce Gold Standard):
   - DEFAULT for direct-response e-commerce, catalog products, and Advantage+ Sales campaigns across all price tiers.
   - Pre-qualifies clicks: sets the clear expectation that clicking leads to a store to purchase physical goods. It filters out low-intent curiosity clickers, lowers landing page bounce rates, and delivers the highest ROAS on conversion-optimized pixel campaigns.
2. "Order Now" (Made-to-Order & Exclusive Drops):
   - Use when the product context explicitly features bespoke tailoring, pre-orders, or a limited-batch seasonal drop.
3. "Learn More" (Editorial & Informational Angles):
   - Use only when the campaign goal is pure Brand Awareness or the creative explicitly drives to an educational landing page, styling quiz, or brand story rather than a direct Shopify product page.
4. "Get Offer" (Promotional):
   - Use only if an explicit bundle discount, introductory offer, or gift with purchase is featured in the creative.

═══════════════════════════════════════════════════════════════════
OUTPUT FORMAT SPECIFICATION
═══════════════════════════════════════════════════════════════════
Respond ONLY with a valid JSON object matching this exact structure:
{
  "headline": "Maximum 8 words. A bold statement or specific product detail. Never a question. Never abstract or clever for its own sake.",
  "primaryText": "2 to 3 punchy sentences. Sentence 1 hooks the moment or feeling. Sentence 2 grounds it in specific product details. Sentence 3 is an action or memorable truth.",
  "description": "1 sentence under 20 words. A specific physical detail that adds fresh information not repeated in the primary text.",
  "cta": "One of: Shop Now, Learn More, Order Now, Get Offer, Sign Up, Book Now, Contact Us",
  "copywriterNote": "A single concise sentence explaining the strategic copywriting rationale for this specific product and audience (written like you're advising a busy e-commerce founder: no fluff or jargon, lead with why this angle, sensory grounding, or psychological tension converts in this market).",
  "angleUsed": "One sentence naming the primary psychological angle and lead claim this copy centres on (e.g. 'First-time buyer confidence: pull-on fit with no sizing anxiety' or 'Material truth: hand-beaded cowrie shell hem as the hero sensory detail'). The hooks engine reads this to ensure its 3 hooks cover genuinely different territory."
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

  const currentCredits = availableCredits(integration, cols.hasCredits);

  const hasCredits = currentCredits > 0;

  try {
    const body: Partial<GenerateRequest> = await request.json();

    const requestId = body.requestId || randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      return NextResponse.json({ error: "Invalid request ID" }, { status: 400 });
    }
    const requestInput = { ...body };
    delete requestInput.requestId;
    const requestHash = createHash("sha256").update(JSON.stringify(requestInput)).digest("hex");
    const receipt = await getGenerationReceipt(userId!, requestId, requestHash);
    if (receipt) return NextResponse.json(receipt);
    const isRegeneration = body.isRegeneration === true;
    let reusableRecommendations: MetaRecommendations | null = null;
    if (isRegeneration) {
      const campaign = body.campaignId ? await getCampaignById(userId!, body.campaignId) : null;
      const versions = campaign ? await getBriefVersions(userId!, campaign.id) : [];
      if (!campaign || !versions.length) {
        return NextResponse.json({ error: "Original brief session not found. Please create a brief first." }, { status: 404 });
      }
      if (versions.length >= 4) {
        return NextResponse.json({ error: "Free variations are limited to three alternatives per brief." }, { status: 409 });
      }

      const canonicalProduct = canonicalRegenerationProduct(campaign, body);
      if (!canonicalProduct) {
        return NextResponse.json({ error: "Voice variations require the same saved product details. Start a new brief if the product changed." }, { status: 409 });
      }
      Object.assign(body, canonicalProduct);
      if (!await isBriefRegenerationCommitReady()) {
        return NextResponse.json({
          error: "Voice variations are temporarily unavailable while the brief save is being updated. No AI call was made. Please try again later.",
        }, { status: 503 });
      }
      reusableRecommendations = reusableRecommendationsFromVersions(
        versions,
        body.productName!,
        body.campaignGoal || "Drive Website Sales",
      );
    }

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
    if (![brandName, productName, productDescription].every((v) => typeof v === "string" && v.trim().length > 0 && v.length <= 20000)) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    if (typeof brandName !== "string" || typeof productName !== "string" || typeof productDescription !== "string") {
      return NextResponse.json({ error: "Invalid product fields" }, { status: 400 });
    }
    if (!integration?.store_snapshot) {
      return NextResponse.json({ error: "Sync your Shopify store before generating a brief." }, { status: 409 });
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

    const storeSnapshot = integration?.store_snapshot;
    const catalogEvidenceProduct = (storeSnapshot?.products || []).find(
      (product: StoreProduct) =>
        product.name.trim().toLowerCase() === productName.trim().toLowerCase() ||
        (product.id && String(product.id) === String(productName)),
    ) as StoreProduct | undefined;
    const catalogClaimEvidence = (catalogEvidenceProduct?.catalog_claims || [])
      .map((claim) => `${claim.key}: ${claim.value}`)
      .join("; ");
    const topChannel = storeSnapshot?.orders?.acquisition_channels?.[0];
    const channelGuidance = getChannelBehavioralGuidance(
      topChannel?.channel,
      topChannel?.percentage
    );
    const geographicGuidance = getGeographicBuyingDynamics(
      shopifyStoreCountry,
      currency,
      topCustomerLocations
    );
    const marketingEvidence = summarizeMarketingHistory(
      storeSnapshot?.prespend?.marketing_history
    );

    const textContent = 
`Generate Meta ad copy for:

Brand: ${brandName}
Product: ${productName}
Description: ${productDescription}
Verified Shopify catalog tags: ${catalogEvidenceProduct?.tags?.join(", ") || "None recorded"}
Verified Shopify catalog claims: ${catalogClaimEvidence || "None recorded"}

Store Primary Country: ${shopifyStoreCountry || "Unknown"}
Top Customer Locations: ${formattedLocations}
Product Price: ${productPrice || "Unknown"}
Store AOV: ${storeAov || "Unknown"}
Store Currency: ${currency}
Shopify Marketing History: ${marketingEvidence}

Audience: ${targetAudience || "Not specified"}
Goal: ${campaignGoal}
Tone: ${tonePreference}
${productVariants ? `Available Variants/Sizes: ${productVariants}` : ""}

${channelGuidance ? `${channelGuidance}\n` : ""}${geographicGuidance ? `${geographicGuidance}\n` : ""}`.trim() + "\n\n" +
`${isVideo ? 
  `CRITICAL: The ad creative is a VIDEO. 
  A 10-frame sequential storyboard of the video has been provided.
  Ensure the copy works perfectly alongside motion-heavy content. 
  Do not refer to "this picture" or static imagery.` 
  : imageUrl ?
  `A product image has been provided.

  Before writing a single word of copy, silently assess two things:
  1. What is this image primarily communicating? (e.g. product in use or on a person, craft detail or texture close-up, lifestyle or setting context, scale and form, flat lay or product-only shot)
  2. What does this image NOT show — and therefore what must the copy carry?

  Your copy and the image must never be doing the same job:
  - If the image shows the product in use or on a model/person → copy sells the experience of using/owning it, the occasion or friction it unlocks, or the one physical detail that earns it a place in someone's daily life or routine. Never describe the shape the eye can already see.
  - If the image shows craft detail, texture, or a close-up → copy sells the identity and transformation — who the customer becomes, what moment this product is made for.
  - If the image shows a lifestyle, dynamic, or editorial context → copy anchors to product truth — what it is made of, what specific physical detail makes this product worth buying, what distinguishes it from anything else.
  - If the image is a flat lay, product-only, or white-background shot → copy sells the transformation — what changes for the person who owns this, what problem it solves, what feeling, utility, or elevation it creates in real-world use.

  In every case: never describe what the eye already sees. Never claim any material, closure, or feature not explicitly stated in the product title, description, verified catalog tags, or catalog claims.`
  : ""}
  
${productVariants ? 
  `CRITICAL: The available sizes/variants are limited to: ${productVariants}. 
  You MUST weave this limitation into the copy naturally. Do not sound apologetic. 
  Instead, use it to create scarcity or exclusivity (e.g. "Only available in ${productVariants}").`
  : ""}

${gatewayInsight?.currentProductClassification === "Gateway" ?
  `CRITICAL: This product is verified as a GATEWAY PRODUCT.
  It is proven by store cohort data to convert cold strangers into first-time customers.
  Your hook and primary text MUST lower first-time buyer hesitation:
  - Address quality confidence, tactile material finish, fit/utility, and ease of first-time purchase.
  - Give a hesitant customer who has never ordered from this brand a clear reason to make their first purchase.
  ${(gatewayInsight.currentProductVelocity ?? 0) > (gatewayInsight.storeMedianVelocity || 0) ? `Velocity signal: High customer demand, fast-moving restocks.` : ""}
  ${(gatewayInsight.currentProductRepeatRate ?? 0) > 0.1 ? `Repeat buying power: Buyers who started with this product came back to order again.` : ""}`
  : gatewayInsight?.currentProductClassification === "Consideration" ?
  `CRITICAL: This product is classified as a CONSIDERATION PRODUCT. It converts warm or returning traffic.
  Your hook MUST be derived from its premium attributes and the fact that it is a high-consideration purchase. Address the quality and investment value.`
  : ""}

${isNewLaunch ? `NEW LAUNCH BRIEF: This product has fewer than 3 orders — sell the sensory design and utility, not the track record.
  CRITICAL for New Launches:
  - Lead with the sensory truth of the form, materials, tactile finish, and daily utility.
  - Ban generic announcement clichés like "Introducing...", "The [Product] is here", or "First look — see it before it's part of everyone's rotation".
  - NEVER use social proof phrases like "loved by thousands", "our best-seller", or "customers say" — there is no purchase history to back this up.
  - NEVER use scarcity tactics like "selling fast" or "only X left".
  - Sell why this product solves a real customer friction or elevates a daily routine (e.g. effortless daily use, superior durability, refined finish, versatile application from morning to night).` : ""}

${(productDescription || "").trim().split(/\s+/).filter(Boolean).length < 30 ?
  `SPARSE DESCRIPTION ALERT: The product description provided is minimal (under 30 words).
  CRITICAL — do NOT extrapolate, invent, or assume any material, closure, fabric blend, fit detail, or feature not explicitly stated.
  Stay anchored exclusively to what is confirmed in the product title, description, verified catalog tags and claims, or what is directly visible in the image.
  Narrow and specific copy grounded in confirmed truth always outperforms broad plausible-sounding copy. Write less and mean more.` : ""}`;

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

        let res = await fetchSafeImage(fetchUrl);
        // If resized CDN URL failed (e.g. 404 or CDN rejection), fallback to the original raw URL
        if (!res.ok && fetchUrl !== url) {
          console.warn(`Resized image URL returned ${res.status} ${res.statusText}, retrying with original URL: ${url}`);
          res = await fetchSafeImage(url);
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

    // The media stays identical across voice variations. Cache it separately
    // from the tone-specific text so later variations can reuse image tokens.
    const lastVisualBlock = messageContent[messageContent.length - 1];
    if (lastVisualBlock?.type === "image") {
      lastVisualBlock.cache_control = { type: "ephemeral" };
    }

    messageContent.push({
      type: "text",
      text: textContent,
      // Write the image/storyboard and prompt prefix on the first request so a
      // validator retry can read it from cache rather than paying to reprocess it.
      cache_control: { type: "ephemeral" },
    });

    // Resolve matching StoreProduct or construct targetProductOverride for strict single-SKU isolation
    const storeProducts = (integration?.store_snapshot?.products || []) as StoreProduct[];
    const matchedProduct = catalogEvidenceProduct || storeProducts.find(
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
      collection: matchedProduct?.collection || matchedProduct?.product_type || "",
      image_url: imageUrl || matchedProduct?.image_url || "",
      should_advertise: true,
      tags: matchedProduct?.tags && matchedProduct.tags.length > 0 ? matchedProduct.tags : [],
      product_type: matchedProduct?.product_type || matchedProduct?.collection || "",
      has_partial_stock: matchedProduct?.has_partial_stock ?? false,
      in_stock_variant_count: matchedProduct?.in_stock_variant_count || 1,
      total_variant_count: matchedProduct?.total_variant_count || 1,
    };

    // ── Step 1: Generate ad copy first ──────────────────────────────────────
    // The copywriter runs alone. Its output includes `angleUsed` — a one-sentence
    // summary of the primary psychological claim the copy leads on. That field
    // is then passed to the hooks engine so the brief's 3 hooks cover genuinely
    // different territory rather than converging on the same gateway angle.
    const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4096,
      system: [
        {
          type: "text",
          text: COPYWRITER_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: messageContent }],
    });

    if (userId) {
      await logApiUsage(userId, "brief_generation", message.usage, message.model);
    }

    console.log("[Anthropic Prompt Caching - Copy Generation]", {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      stop_reason: message.stop_reason,
      content_blocks: message.content.map((b) => b.type),
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
      console.error("Claude returned non-text blocks:", message.content);
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

    // Normalize snake_case or variant keys and guarantee a high-converting copywriterNote
    if (parsedResponse.primary_text && !parsedResponse.primaryText) {
      parsedResponse.primaryText = parsedResponse.primary_text;
    }
    const rawNote =
      parsedResponse.copywriterNote ??
      parsedResponse.copywriter_note ??
      parsedResponse.copywriterNotes ??
      parsedResponse.copywriter_notes ??
      "";
    const cleanNote = typeof rawNote === "string" ? rawNote.trim() : "";
    const copywriterNote =
      cleanNote ||
      `Written to catch feed attention, highlight the genuine craftsmanship of ${productName}, and encourage shoppers to visit your store and buy.`;

    parsedResponse.copywriterNote = copywriterNote;
    parsedResponse = normalizeCopyPunctuation(parsedResponse);

    // ─── Code-Side Copy Validator ────────────────────────────────────────────
    // Runs banned-string scan + hallucination check. On failure, fires one
    // targeted retry at temp 0.2 with a specific error message before the
    // credit is deducted — so a failed generation never costs the founder a credit.
    const { groundedProductEvidence, forbiddenProductNames, factualEvidence } = buildCopyValidationEvidence(
      {
        id: String(targetProductOverride.id),
        name: productName,
        description: productDescription || matchedProduct?.description || "",
        tags: matchedProduct?.tags || [],
        product_type: matchedProduct?.product_type || "",
      },
      storeProducts.map((product) => ({ id: String(product.id), name: product.name })),
      catalogClaimEvidence,
      storeSnapshot?.store?.country || shopifyStoreCountry || "",
    );
    let copyValidationErrors = validateCopy(
      parsedResponse,
      groundedProductEvidence,
      forbiddenProductNames,
      factualEvidence,
    );

    if (copyValidationErrors.length > 0) {
      console.warn("[Copy Validator] Initial copy failed validation:", copyValidationErrors);

      try {
        const retryMessage = await client.messages.create({
          model: "claude-sonnet-5",
          max_tokens: 4096,
          system: [
            {
              type: "text",
              text: COPYWRITER_SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [
            { role: "user", content: messageContent },
            {
              role: "assistant",
              content: responseBlock.text,
            },
            {
              role: "user",
              content: `The generated copy failed quality validation with the following issues:\n${copyValidationErrors.map((e) => `- ${e}`).join("\n")}\n\nPlease regenerate the copy strictly fixing each issue. Maintain the same product, same strategic angle — only correct the specific violations listed above.`,
            },
          ],
        });
        await logApiUsage(userId, "copy_validation_retry", retryMessage.usage, retryMessage.model);

        const retryBlock = retryMessage.content.find((b) => b.type === "text");
        if (retryBlock && retryBlock.type === "text") {
          try {
            let retryCleaned = retryBlock.text.trim();
            const retryJsonMatch = retryCleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
            if (retryJsonMatch) {
              retryCleaned = retryJsonMatch[1].trim();
            } else {
              const s = retryCleaned.indexOf("{");
              const e = retryCleaned.lastIndexOf("}");
              if (s !== -1 && e !== -1 && e > s) retryCleaned = retryCleaned.substring(s, e + 1);
            }
            let retryParsed = JSON.parse(retryCleaned);
            if (retryParsed.primary_text && !retryParsed.primaryText) {
              retryParsed.primaryText = retryParsed.primary_text;
            }
            retryParsed.copywriterNote = retryParsed.copywriterNote || copywriterNote;
            retryParsed = normalizeCopyPunctuation(retryParsed);

            copyValidationErrors = validateCopy(
              retryParsed,
              groundedProductEvidence,
              forbiddenProductNames,
              factualEvidence,
            );
            if (copyValidationErrors.length === 0) {
              parsedResponse = retryParsed;
              console.log("[Copy Validator] Retry passed validation.");
            } else {
              console.error("[Copy Validator Alert] Copy still failed after retry:", copyValidationErrors);
              // Reject below; never deliver known-invalid facts.
            }
          } catch (retryParseErr) {
            console.error("[Copy Validator] Retry JSON parse failed:", retryParseErr);
          }
        }
      } catch (retryErr) {
        console.error("[Copy Validator] Retry API call failed:", retryErr);
      }
    }

    if (copyValidationErrors.length > 0) {
      return NextResponse.json({ error: "We could not validate the product claims in this copy. Please retry. No credit was charged." }, { status: 422 });
    }

    // ── Step 2: Generate targeting profile with copy angle as exclusion ──────
    // angleUsed is extracted from the now-validated copy. The hooks engine
    // receives it as an explicit exclusion so its 3 hooks are forced to cover
    // psychological territory the copy has not already claimed.
    // If skipTargeting is true (used for progressive rendering), we skip this step
    // and return the validated copy immediately, allowing the client to fetch
    // targeting asynchronously.
    const angleUsed: string | null =
      typeof parsedResponse?.angleUsed === "string"
        ? parsedResponse.angleUsed.trim() || null
        : null;

    // A voice change keeps the product and campaign settings. Reuse the saved
    // audience, budget and hooks instead of regenerating the full profile.
    const recommendations = reusableRecommendations ?? await generateRecommendations(
      integration.store_snapshot, undefined, userId, targetProductOverride, angleUsed
    );
    const generatedAt = new Date().toISOString();
    const context = {
      schemaVersion: 2,
      generatedAt,
      ruleVersion: "prespend-v1",
      model: "claude-sonnet-5",
      brandName, productName, productPrice: parsedPrice, goal: campaignGoal,
      generatedCopy: parsedResponse, selectedCta: parsedResponse.cta,
      aiInsights: recommendations,
      storeInsights: integration.store_snapshot,
      gatewayInsight: buildGenerationContext(integration.store_snapshot, productName).gatewayInsight,
      isNewLaunch: !!isNewLaunch,
      selectedDuration: 14, selectedIntlDuration: 14, selectedStrategyIndex: 1, selectedIntlStrategyIndex: 1,
    };
    const result = await commitBriefGeneration({
      p_user_id: userId!, p_request_id: requestId, p_request_hash: requestHash,
      p_campaign_id: isRegeneration ? body.campaignId! : null,
      p_campaign: {
        brand_name: brandName, product_name: productName, product_description: productDescription,
        target_audience: targetAudience, campaign_goal: campaignGoal, tone_preference: tonePreference,
        platform: platform ?? null, media_url: body.mediaUrl ?? imageUrl ?? null,
        product_price: productPrice || null,
      },
      p_copy: {
        headline: parsedResponse.headline, primary_text: parsedResponse.primaryText,
        description: parsedResponse.description, cta: parsedResponse.cta, copywriter_note: parsedResponse.copywriterNote,
      },
      p_context: context,
      p_response: {
        ...parsedResponse, angleUsed, aiInsights: recommendations, briefData: context,
        creative_hooks: recommendations.creative_hooks,
        advantage_plus_guidance: recommendations.advantage_plus_guidance,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Campaign API Generation Error:", error);

    if (error instanceof Error && error.message === "no_credits") {
      return NextResponse.json({
        error: "no_credits",
        message: "You have no briefs remaining. Purchase a pack to continue.",
        redirect: "/pricing",
      }, { status: 402 });
    }

    if (error instanceof Error && error.message === "Could not confirm the brief was saved. Please retry.") {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }

    if (error instanceof CreativeHookGenerationError) {
      return NextResponse.json(
        {
          error:
            "Creative hooks could not be generated. Please retry. No credit was charged.",
        },
        { status: 502 }
      );
    }

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
