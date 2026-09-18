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
import { getChannelBehavioralGuidance, getGeographicBuyingDynamics } from "@/lib/campaigns/qualitative-guidance";

// Credit-gating: check balance before generation

export const runtime = "nodejs";
export const maxDuration = 60;

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

interface CopyOutput {
  headline?: string;
  primaryText?: string;
  description?: string;
  cta?: string;
  copywriterNote?: string;
}

/**
 * Code-side enforcement of the rules the COPYWRITER_SYSTEM_PROMPT promises.
 *
 * Two passes:
 * 1. Banned string scan — catches exclamation marks, announcement clichés,
 *    unverified demand/scarcity claims, and universal fit assertions that the
 *    system prompt bans but previously had zero code enforcement behind them.
 * 2. Closure/material hallucination check — extracts verifiable product-fact
 *    terms (fabric types, closures, construction details) from the generated
 *    copy and confirms each one is present in the product description. A term
 *    in the copy that isn't in the description is a hallucination risk.
 */
function validateCopy(copy: CopyOutput, productDescription: string): string[] {
  const errors: string[] = [];
  const allText = [copy.headline, copy.primaryText, copy.description]
    .filter(Boolean)
    .join(" ");

  // ── Pass 1: Banned string patterns ──────────────────────────────────────
  const bannedPatterns: Array<{ pattern: RegExp; message: string }> = [
    { pattern: /!/,                                          message: "Exclamation mark detected — banned for premium copy" },
    { pattern: /\bIntroducing\b/i,                           message: "Banned announcement phrase: 'Introducing'" },
    { pattern: /\bMeet the\b/i,                              message: "Banned announcement phrase: 'Meet the'" },
    { pattern: /\bThe .{1,40} (is here|arrives|has arrived)\b/i, message: "Banned passive announcement headline" },
    { pattern: /\bflatters (all|every) body\b/i,             message: "Unverified universal fit claim" },
    { pattern: /\bmade for every body\b/i,                   message: "Unverified universal fit claim" },
    { pattern: /\bloved by thousands\b/i,                    message: "Unverified social proof claim" },
    { pattern: /\b(selling|sold) out fast\b/i,               message: "Unverified scarcity claim" },
    { pattern: /\bback by popular demand\b/i,                message: "Unverified demand claim" },
    { pattern: /\b(our |the )?fastest.selling\b/i,           message: "Unverified demand claim: 'fastest-selling'" },
    { pattern: /\bkeep(s)? selling out\b/i,                  message: "Unverified demand claim: 'keeps selling out'" },
    { pattern: /\balways sold out\b/i,                       message: "Unverified demand claim: 'always sold out'" },
    { pattern: /\bgame.?changer\b/i,                         message: "Banned cliché: 'game changer'" },
    { pattern: /\bElevate your\b/i,                          message: "Banned cliché: 'Elevate your'" },
    { pattern: /\bStep into\b/i,                             message: "Banned cliché: 'Step into'" },
    { pattern: /\bThere is a version of you\b/i,             message: "Banned abstract cliché" },
    { pattern: /\bImagine a world\b/i,                       message: "Banned abstract cliché" },
    { pattern: /\bLook no further\b/i,                       message: "Banned cliché: 'Look no further'" },
  ];

  for (const { pattern, message } of bannedPatterns) {
    if (pattern.test(allText)) {
      errors.push(message);
    }
  }

  // ── Pass 2: Closure & material hallucination check ───────────────────────
  // Terms that are specific and verifiable — if the copy claims them, they
  // must appear in the product description. Generic words (dress, style, etc.)
  // are intentionally excluded from this list.
  const verifiableTerms = [
    // Closures & fastenings
    "zipper", "zip", "drawstring", "elastic", "button", "buttons",
    "buckle", "velcro", "snap", "hook-and-eye", "lace-up", "belt", "sash",
    // Fabrics & materials
    "linen", "silk", "cotton", "wool", "cashmere", "satin", "chiffon",
    "velvet", "leather", "denim", "suede", "nylon", "polyester", "rayon",
    "viscose", "modal", "bamboo", "jersey", "tweed", "organza", "tulle",
    "crepe", "georgette", "brocade", "twill", "poplin",
    // Embellishments & construction
    "embroidery", "embroidered", "beaded", "beading", "cowrie", "sequin",
    "sequined", "lace", "crochet", "smocking", "pleated", "pleats",
    "ruffle", "ruffles", "fringe", "tassels", "pockets",
    // Specific fit/construction claims
    "unisex", "genderless", "adjustable", "stretch", "lined", "lining",
  ];

  const descLower = (productDescription || "").toLowerCase();
  const copyLower = allText.toLowerCase();

  for (const term of verifiableTerms) {
    const termRegex = new RegExp(`\\b${term}\\b`, "i");
    if (termRegex.test(copyLower) && !termRegex.test(descLower)) {
      errors.push(`Possible hallucination: "${term}" is in copy but not in product description`);
    }
  }

  return errors;
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
   - ABSOLUTE BAN on false urgency or unverified demand claims: No countdowns, no "Hurry!", no "Don't miss out!", no "Selling out fast!", no "Keep selling out", no "Always sold out", no "Back by popular demand" unless verified store history explicitly documents repeated stockouts.
   - Build desire through precision, posture, and descriptive sensory power.
2. Creative Visual Grounding:
   - When an image is provided: Root the copy in visual truth — silhouette, texture, color tones, cut, and occasion mood.
   - When a video storyboard is provided: Write copy that complements motion, pacing, and dynamic on-screen transitions. Never refer to "this picture" or static imagery when a video storyboard is provided.
3. Sell the Outcome, Not the Specs:
   - Do not merely summarize the raw product description.
   - Pull 1 or 2 striking physical or material details to anchor credibility, then sell how wearing/using the product feels, transforms, or functions.
4. Ban on Abstract Clichés:
   - Never use: "There is a version of you...", "Imagine a world...", "Step into...", "Elevate your...", "Look no further...", "Game changer".
   - Never use passive announcement headlines: "Introducing...", "Meet the...", "The [Product] is here", "The [Product] arrives in [Color]". Every headline must be an active, arresting hook or sensory product truth.
   - Avoid melodrama and poetic fluff. Specificity always beats generalities.
5. Compliance & Cleanliness:
   - NEVER include the product price or currency in the copy (Meta policy & pricing fluidity).
   - NEVER reference stock counts (e.g. "only 3 left") — stock goes stale and violates advertising policies.
   - NEVER assume the reader's geographic location or local currency.
6. Grounded Material, Demand & Feature Truthfulness (Strict Zero-Hallucination Mandate):
   - ONLY reference physical materials (e.g. linen, silk, wool, cotton, cowrie shells), closures (e.g. drawstring, zipper, elastic waist, buttons), or silhouettes that are EXPLICITLY documented in the product title/description or clearly visible in the product image.
   - NEVER invent or assume closures: do not claim "drawstring waist", "hidden zipper", or "button fly" unless explicitly stated in the product details.
   - NEVER invent unstated fabrics, linings, or material blends.
   - NEVER claim an item is "unisex", "genderless", or "for him and her" unless the product description explicitly uses those terms. If the product is womenswear, write with female styling nuance; if menswear, write with male nuance.
   - NEVER claim an item "fits every body", "made for every body", or "flatters all body types" unless explicit universal sizing or adjustable wrap specifications are documented in the product description.
   - NEVER make unverified demand claims like "why these keep selling out" or "our fastest-selling piece" — write from observed product craftsmanship, drape, silhouette, and utility instead.

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
      skipTargeting = false,
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

    const storeSnapshot = integration?.store_snapshot;
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

${channelGuidance ? `${channelGuidance}\n` : ""}${geographicGuidance ? `${geographicGuidance}\n` : ""}`.trim() + "\n\n" +
`${isVideo ? 
  `CRITICAL: The ad creative is a VIDEO. 
  A 10-frame sequential storyboard of the video has been provided.
  Ensure the copy works perfectly alongside motion-heavy content. 
  Do not refer to "this picture" or static imagery.` 
  : imageUrl ?
  `A product image has been provided.

  Before writing a single word of copy, silently assess two things:
  1. What is this image primarily communicating? (e.g. fit and silhouette on a model, craft detail or texture close-up, lifestyle or occasion context, movement and drape, flat lay or product-only shot)
  2. What does this image NOT show — and therefore what must the copy carry?

  Your copy and the image must never be doing the same job:
  - If the image shows fit, silhouette, or the product on a model → copy sells the feeling of wearing it, the occasion it unlocks, or the one physical detail that earns the piece its place in someone's wardrobe. Never describe the shape the eye can already see.
  - If the image shows craft detail, texture, or a close-up → copy sells the identity and transformation — who the wearer becomes, what moment this piece is made for.
  - If the image shows a lifestyle, movement, or editorial context → copy anchors to product truth — what it is made of, what specific physical detail makes this piece worth buying, what distinguishes it from anything else.
  - If the image is a flat lay, product-only, or white-background shot → copy sells the transformation — what changes for the person who owns this, what problem it solves, what feeling it creates on the body.

  In every case: never describe what the eye already sees. Never claim any material, closure, or feature not explicitly stated in the product description.`
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
  - Address sizing, flattering drape, and tactile fabric confidence.
  - Give a hesitant customer who has never ordered from this brand a clear reason to make their first purchase.
  ${(gatewayInsight.currentProductVelocity ?? 0) > (gatewayInsight.storeMedianVelocity || 0) ? `Velocity signal: High customer demand, fast-moving restocks.` : ""}
  ${(gatewayInsight.currentProductRepeatRate ?? 0) > 0.1 ? `Repeat buying power: Buyers who started with this product came back to order again.` : ""}`
  : gatewayInsight?.currentProductClassification === "Consideration" ?
  `CRITICAL: This product is classified as a CONSIDERATION PRODUCT. It converts warm or returning traffic.
  Your hook MUST be derived from its premium attributes and the fact that it is a high-consideration purchase. Address the quality and investment value.`
  : ""}

${isNewLaunch ? `NEW LAUNCH BRIEF: This product has fewer than 3 orders — sell the sensory design and utility, not the track record.
  CRITICAL for New Launches:
  - Lead with the sensory truth of the cut, silhouette, fabric drape, and daily wearability.
  - Ban generic announcement clichés like "Introducing...", "The [Product] is here", or "First look — see it before it's part of everyone's rotation".
  - NEVER use social proof phrases like "loved by thousands", "our best-seller", or "customers say" — there is no purchase history to back this up.
  - NEVER use scarcity tactics like "selling fast" or "only X left".
  - Sell why this piece solves a wardrobe dilemma (e.g. breathable heat-proof comfort, pockets that don't bunch, versatile styling from day to evening).` : ""}

${(productDescription || "").trim().split(/\s+/).filter(Boolean).length < 30 ?
  `SPARSE DESCRIPTION ALERT: The product description provided is minimal (under 30 words).
  CRITICAL — do NOT extrapolate, invent, or assume any material, closure, fabric blend, fit detail, or feature not explicitly stated.
  Stay anchored exclusively to what is confirmed in the description and what is directly visible in the image.
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

    // ─── Code-Side Copy Validator ────────────────────────────────────────────
    // Runs banned-string scan + hallucination check. On failure, fires one
    // targeted retry at temp 0.2 with a specific error message before the
    // credit is deducted — so a failed generation never costs the founder a credit.
    let copyValidationErrors = validateCopy(parsedResponse, productDescription || "");

    if (copyValidationErrors.length > 0) {
      console.warn("[Copy Validator] Initial copy failed validation:", copyValidationErrors);

      try {
        const retryMessage = await client.messages.create({
          model: "claude-sonnet-5",
          max_tokens: 4096,
          temperature: 0.2,
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
            const retryParsed = JSON.parse(retryCleaned);
            if (retryParsed.primary_text && !retryParsed.primaryText) {
              retryParsed.primaryText = retryParsed.primary_text;
            }
            retryParsed.copywriterNote = retryParsed.copywriterNote || copywriterNote;

            copyValidationErrors = validateCopy(retryParsed, productDescription || "");
            if (copyValidationErrors.length === 0) {
              parsedResponse = retryParsed;
              console.log("[Copy Validator] Retry passed validation.");
            } else {
              console.error("[Copy Validator Alert] Copy still failed after retry:", copyValidationErrors);
              // Ship the original — a live but imperfect brief is better than blocking the founder.
            }
          } catch (retryParseErr) {
            console.error("[Copy Validator] Retry JSON parse failed:", retryParseErr);
          }
        }
      } catch (retryErr) {
        console.error("[Copy Validator] Retry API call failed:", retryErr);
      }
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

    const targetingProfile = !skipTargeting && integration?.store_snapshot
      ? await generateTargetingProfile(
          integration.store_snapshot,
          1,
          50,
          userId,
          targetProductOverride,
          angleUsed
        ).catch((profileErr: unknown) => {
          console.error("Targeting profile generation error:", profileErr);
          return null;
        })
      : null;

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
        angleUsed,
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
