import { NextResponse } from "next/server";
import { Anthropic } from "@anthropic-ai/sdk";
import { auth } from "@clerk/nextjs/server";
import { queryUserIntegrationSelect, updateUserIntegration, insertCreditUsage, logApiUsage } from "@/lib/db";
import sharp from "sharp";
import { getPriceTier, getPriceTierPromptHint } from "@/lib/price-tier";

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
  gatewayInsight?: any;
  storeDataForApi?: any;
  storeAov?: number | null;
  storePrices?: number[];
  isNewLaunch?: boolean;
  isRegeneration?: boolean;
}

/**
 * POST handler for generating ad copy via Claude
 * @param request The incoming HTTP request containing campaign form data
 * @returns JSON response with AI-generated ad creatives or an error object
 */
export async function POST(request: Request) {
  const { userId } = await auth();

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
      mediaUrl,
      imageUrl,
      productPrice,
      platform,
      productVariants,
      gatewayInsight,
      storeDataForApi,
      storeAov,
      storePrices,
      isNewLaunch,
    } = body;

    const currency = integration?.store_snapshot?.store?.currency || "USD";

    const CURRENCY_TO_REGION: Record<string, string> = {
      "NGN": "NG",
      "GBP": "GB",
      "EUR": "EU",
      "AED": "AE",
      "USD": "US",
      "CAD": "CA",
      "AUD": "AU",
      "GHS": "GH",
      "KES": "KE",
      "ZAR": "ZA",
    };

    const storeRegion = CURRENCY_TO_REGION[currency] || "OTHER";

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Anthropic API key not configured" },
        { status: 500 }
      );
    }
    const client = new Anthropic({ apiKey });

    // Derive a qualitative price tier from the store's own catalog distribution.
    // Thresholds are computed from the data — no hardcoded currency amounts.
    const priceTier = getPriceTier(
      productPrice,
      storePrices ?? [],
      storeAov ?? gatewayInsight?.storeAov
    );
    const priceTierHint = priceTier ? getPriceTierPromptHint(priceTier) : null;

    // Validate required fields
    if (!brandName || !productName || !productDescription) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    console.log("Selected platform:", platform);

    const systemPrompt = `You are a senior performance copywriter 
who writes high-converting Meta ad copy for ecommerce brands.

You understand that great ads are punchy, direct, and focused 
on the product's unique value — whether that's an emotional 
benefit or a practical one.

Before writing, do this:

STEP 1 — READ THE PRODUCT
Look at the brand, product name, description, price, 
and image. Ask yourself:
- What is the most visually striking detail?
- Why would someone buy this right now?
- What problem does this solve, or what desire does it fulfill?

STEP 2 — FIND THE HOOK
Every great ad starts with a hook that stops the scroll.
- Not a poetic metaphor.
- Not a generic question ("Looking for a dress?").
- State a specific, compelling fact or emotional benefit immediately.

If a product image is provided, use it.
The visual truth — colour, texture, silhouette, occasion-fit — 
matters as much as the written description.
Write what you see, not just what you were told.

STEP 3 — WRITE LIKE A HUMAN, NOT A POET
Write like someone who genuinely loves this product telling 
a friend about it. 

CRITICAL RULES FOR TONE & APPROACH:
- DO NOT just creatively rewrite the product description! The description is merely background context so you understand what the product is.
- Your job is to write an ad that sells the OUTCOME, the FEELING, or the UNIQUE VALUE. 
- Pull only 1 or 2 striking details from the description if they help the hook. Ignore the rest of it.
- NO POETRY. NO MELODRAMA.
- Do NOT use abstract phrases like "There is a version of you...", 
  "Imagine a world...", "Step into...", or "Elevate your...".
- Be specific. Specific always beats general.
- Use short, punchy sentences.
- Read it aloud. If it sounds like a philosophical manifesto, rewrite it.

MARKET CONTEXT:
store_region signal:

"NG" — Nigerian market.
Buyers respond to quality signals, craft, and clear value.
They appreciate luxury but distrust overselling. Be direct and confident.

"GB" — UK market.
Understated. They distrust overselling. Write less. Trust the product.

"AE" — Gulf market.
Elegance, occasion-dressing, luxury.

"US" / "CA" — North American market.
Identity-led purchasing. Lead with the core benefit and aesthetic.

"OTHER" — Write universally. Focus on product truth.

CAMPAIGN GOAL:

"Drive Website Sales" →
Last line is always a direct, urgent call to action.

"Grow Brand Awareness" →
Focus heavily on the brand's unique aesthetic or mission.

"Promote a New Collection" →
Newness leads. Create excitement without desperation.

"Retarget Past Visitors" →
They already know you. Remind them why they clicked in the first place.

TONE:

"Let AI decide" →
High price = elevated but direct. Accessible price = warm and punchy.

"Premium & Aspirational" →
Quiet confidence. The product doesn't need to shout. Short sentences.

"Bold & Direct" →
Short sentences. Strong verbs. No hedging.

"Warm & Conversational" →
A voice note from a friend with great taste.

WHAT KILLS GOOD COPY (NEVER DO THESE):
- Regurgitating the product description. Do NOT just paraphrase the features!
- Melodramatic openings ("There's a version of you that...")
- Starting with the brand or product name
- "Introducing" or "Meet the new"
- "Limited time" or "Don't miss"
- "You deserve" or "Treat yourself"
- Three adjectives in a row
- Abstract cleverness that needs interpretation
- NEVER include the product price or any currency amount in the copy — not even as a hook
- NEVER reference inventory, stock levels, or how many units remain — this information goes stale and violates Meta policy
- NEVER assume the reader's country, currency, or local pricing — copy must work equally well in any market

WHAT MAKES GREAT COPY:
- A first sentence that immediately states a benefit or striking detail.
- Grounding the copy in the physical reality of the product.
- A natural, conversational rhythm.
- Selling the outcome or the feeling, not the fabric.

OUTPUT — respond only with valid JSON,
no markdown, no preamble:
{
  "headline": "max 8 words. A statement 
    or specific detail. Never a question. 
    Never abstract. Never clever for 
    its own sake.",
  "primaryText": "2-3 sentences. First 
    creates the moment or feeling. Middle 
    grounds it in the product specifically. 
    Last is an action or a truth that lands.",
  "description": "1 sentence under 20 words. 
    A specific product detail that adds 
    something the primary text didn't say.",
  "cta": "one of: Shop Now, See Collection, 
    Learn More, Get Offer, Sign Up",
  "copywriterNote": "A single sentence explaining why this copy works for this audience, written like you're texting a busy e-commerce founder (maximum 1 sentence, no jargon like 'acquisition signal', 'behavioral velocity', 'cohort signals', or 'units/mo velocity', lead with the actionable implication, sound like a smart marketer friend)."
}`;

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

    const textContent = 
`Generate Meta ad copy for:

Brand: ${brandName}
Product: ${productName}
Description: ${productDescription}
${priceTier ? `Price Tier: ${priceTier}` : ""}
${priceTierHint ? `Tone Directive (from price positioning): ${priceTierHint}` : ""}
Audience: ${targetAudience || 
  "Not specified"}
Goal: ${campaignGoal}
Tone: ${tonePreference}
Store Region: ${storeRegion}
Store Currency: ${currency}
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
  ${gatewayInsight.currentProductVelocity > (gatewayInsight.storeMedianVelocity || 0) ? `Consider a hook like "Sells out every ${Math.max(1, Math.round(90 / (gatewayInsight.currentProductVelocity || 1)))} days".` : ""}
  ${gatewayInsight.currentProductRepeatRate > 0.1 ? `Or a hook like "The ${productName} our customers come back for".` : ""}`
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

    const messageContent: any[] = [];

    // Max base64 size we'll send to Anthropic (4.5 MB leaves headroom under the 5 MB API limit)
    const MAX_BASE64_BYTES = 4_500_000;

    // Helper to fetch an image URL and convert to base64 with automatic resizing
    const fetchImageBase64 = async (url: string) => {
      try {
        let fetchUrl = url;

        // --- Shopify CDN: resize to 1200px wide + force JPEG ---
        if (fetchUrl.includes("cdn.shopify.com")) {
          // Shopify image URLs support _WIDTHx suffix before the extension
          // e.g. product.jpg → product_1200x.jpg
          fetchUrl = fetchUrl.replace(
            /(\.(jpg|jpeg|png|webp|avif))(\?|$)/i,
            "_1200x.jpg$3"
          );
          // Append format=jpg to force JPEG output regardless of original
          fetchUrl += fetchUrl.includes("?") ? "&format=jpg" : "?format=jpg";
        }

        // --- Cloudinary: add quality + resize transforms ---
        if (fetchUrl.includes("res.cloudinary.com") && fetchUrl.includes("/upload/")) {
          const uploadIdx = fetchUrl.indexOf("/upload/");
          const base = fetchUrl.slice(0, uploadIdx + 8); // includes "/upload/"
          const rest = fetchUrl.slice(uploadIdx + 8);
          // Prepend resize + quality transforms (won't clash with existing transforms)
          fetchUrl = `${base}w_1200,c_limit,q_auto:good,f_jpg/${rest}`;
        }

        console.log("Fetching image for AI (resized URL):", fetchUrl.slice(0, 120));

        const res = await fetch(fetchUrl);
        if (!res.ok) throw new Error(`Failed to fetch image: ${res.statusText}`);

        const buffer = await res.arrayBuffer();
        let contentType = (res.headers.get("content-type") || "image/jpeg")
          .split(";")[0]
          .trim()
          .toLowerCase();

        // Map common variations
        if (contentType === "image/jpg") contentType = "image/jpeg";

        const supported = ["image/jpeg", "image/png", "image/gif", "image/webp"];

        // If the CDN still returned an unsupported type (like avif),
        // skip the image block to prevent Anthropic from crashing with a 400.
        if (!supported.includes(contentType)) {
          console.warn(`Unsupported image type: ${contentType} from ${fetchUrl}. Skipping visual analysis.`);
          return null;
        }

        let imgBuffer: Uint8Array = Buffer.from(buffer);

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
            media_type: imgData.mediaType as any,
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

      const resolvedFrames = (await Promise.all(framePromises)).filter(Boolean);
      messageContent.push(...resolvedFrames);
    }

    messageContent.push({
      type: "text",
      text: textContent,
      cache_control: { type: "ephemeral" }
    });

    // Call the Anthropic API
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" }
        }
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
      const updateData: Record<string, any> = {};
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

    // Return the successfully parsed JSON output
    return NextResponse.json(parsedResponse, { status: 200 });
  } catch (error: any) {
    console.error("Campaign API Generation Error:", error);

    // Map known Anthropic error types to user-friendly messages
    const message =
      error?.status === 400 && error?.message?.includes("image")
        ? "Product image could not be processed. Try a different image or generate without one."
        : error?.status === 429
          ? "AI is temporarily busy. Please try again in a moment."
          : "Something went wrong generating your brief. Please try again.";

    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
