import { NextResponse } from "next/server";
import { Anthropic } from "@anthropic-ai/sdk";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";

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
}

/**
 * POST handler for generating ad copy via Claude
 * @param request The incoming HTTP request containing campaign form data
 * @returns JSON response with AI-generated ad creatives or an error object
 */
export async function POST(request: Request) {
  const { userId } = await auth();

  const { data: integration } = await supabaseAdmin
    .from("user_integrations")
    .select("store_snapshot, credits_balance, credits_unlimited_until")
    .eq("clerk_user_id", userId!)
    .single();

  // Credit gate: check if user has credits or unlimited access
  const hasUnlimited =
    integration?.credits_unlimited_until &&
    new Date(integration.credits_unlimited_until) > new Date();

  const hasCredits =
    (integration?.credits_balance || 0) > 0;

  if (!hasUnlimited && !hasCredits) {
    return NextResponse.json({
      error: "no_credits",
      message: "You have no briefs remaining. Purchase a pack to continue.",
      redirect: "/pricing"
    }, { status: 402 });
  }

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

  console.log("Key check:", 
    process.env.ANTHROPIC_API_KEY?.slice(0,14))
  const apiKey = process.env.ANTHROPIC_API_KEY;
  console.log("API Key loaded:", !!apiKey, 
    "| Prefix:", apiKey?.slice(0, 14));

  if (!apiKey) {
    return NextResponse.json(
      { error: "Anthropic API key not configured" },
      { status: 500 }
    );
  }
  const client = new Anthropic({ 
    apiKey: process.env.ANTHROPIC_API_KEY || "" 
  });

  try {
    const body: Partial<GenerateRequest> = await request.json();

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
    } = body;

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
  "copywriterNote": "1-2 sentences. Name 
    the specific human truth this copy 
    is built on and why it fits this 
    exact audience."
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
${productPrice ? 
  `Price: ${productPrice}` : ""}
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
  : ""}`;

    const messageContent: any[] = [];

    // Helper to fetch an image URL and convert to base64
    const fetchImageBase64 = async (url: string) => {
      try {
        // Force Shopify to return a JPEG to avoid AVIF/WEBP issues
        let fetchUrl = url;
        if (fetchUrl.includes("cdn.shopify.com")) {
          fetchUrl += fetchUrl.includes("?") ? "&format=jpg" : "?format=jpg";
        }

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

        return {
          base64: Buffer.from(buffer).toString("base64"),
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
      text: textContent
    });

    // Call the Anthropic API
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: messageContent }],
    });

    // Check if we received text content
    const responseBlock = message.content.find((block) => block.type === "text");
    if (!responseBlock || responseBlock.type !== "text") {
      throw new Error("No text content returned from Claude");
    }

    let parsedResponse;
    try {
      // Strip markdown code fences if Claude
      // wraps the JSON in json ... 
      const cleaned = responseBlock.text
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      parsedResponse = JSON.parse(cleaned);
    } catch (parseError) {
      console.error("JSON Parsing Error:", parseError);
      return NextResponse.json(
        { error: "Copy generation failed. Try again." },
        { status: 500 }
      );
    }

    // Deduct credit after successful generation
    if (!hasUnlimited) {
      await supabaseAdmin
        .from("user_integrations")
        .update({
          credits_balance: Math.max(
            0,
            (integration?.credits_balance || 0) - 1
          )
        })
        .eq("clerk_user_id", userId!);

      await supabaseAdmin
        .from("credit_usage")
        .insert({
          clerk_user_id: userId!,
          credits_used: 1,
          action: "brief_generated",
        });
    }

    // Return the successfully parsed JSON output
    return NextResponse.json(parsedResponse, { status: 200 });
  } catch (error) {
    console.error("Campaign API Generation Error:", error);
    // Generic fail-safe block according to spec
    return NextResponse.json(
      { error: "Something went wrong", status: 500 },
      { status: 500 }
    );
  }
}
