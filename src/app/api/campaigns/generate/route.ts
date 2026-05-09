import { NextResponse } from "next/server";
import { Anthropic } from "@anthropic-ai/sdk";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";

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
    .select("store_snapshot")
    .eq("clerk_user_id", userId!)
    .single();

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
    } = body;

    // Validate required fields
    if (!brandName || !productName || !productDescription) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    console.log("Selected platform:", platform);

    const systemPrompt = `You are a senior creative director 
who writes Meta ad copy for brands 
across fashion, lifestyle, beauty, 
homewares, and beyond.

You understand that great ads don't sell 
products — they sell a version of the 
person who owns them.

Before writing, do this:

STEP 1 — READ THE BRAND
Look at everything provided — the brand 
name, product name, description, price, 
and image if available. Ask yourself:
- Who buys this and why?
- What does this product make them feel?
- What are they saying about themselves 
  by choosing this over everything else?
- What one specific detail delivers 
  that feeling most powerfully?

STEP 2 — FIND THE ONE TRUE THING
Every great ad is built on one true thing.
Not a feature. Not a benefit. A truth 
that connects the product to a feeling 
or moment in the buyer's life.

Ask:
- What specific detail creates the 
  most desire?
- What moment does this product 
  belong in?
- What does owning this say about 
  the person who chose it?

This works for any product in any 
category. The category doesn't matter. 
The truth does.

If a product image is provided, use it.
The visual truth — colour, texture, 
silhouette, mood, occasion-fit — matters 
as much as the written description.
Write what you see, not just what 
you were told.

STEP 3 — WRITE LIKE A PERSON
Not like a brand. Like someone who 
genuinely loves this product telling 
a friend about it — but a friend with 
taste and economy of words.

Specific always beats general.
Short sentences for impact.
Longer sentences for rhythm and texture.
Read it aloud. If it sounds like an ad, 
rewrite it.

MARKET CONTEXT:
store_region signal:

"NG" — Nigerian market.
Buyers respond to quality signals, craft,
and pieces that feel considered.
Write to their intelligence and 
aspiration. They are not naive.

"GB" — UK market.
Understated. They distrust overselling.
Write less. Trust the product.

"AE" — Gulf market.
Elegance, occasion-dressing, luxury.

"US" / "CA" — North American market.
Identity-led purchasing. They buy to 
express who they are or want to become.

"OTHER" — Write universally.
Focus on product truth. No regional 
cultural references.

CAMPAIGN GOAL:

"Drive Website Sales" →
Last line is always a direct action.
Get them to click.

"Grow Brand Awareness" →
Plant a feeling. Last line can be 
a statement, not a directive.

"Promote a New Collection" →
Newness leads. Create excitement 
without desperation.

"Retarget Past Visitors" →
They already know you. Don't 
re-introduce. Remind them what they 
felt when they first saw it.

TONE:

"Let AI decide" →
Read everything and infer.
High price + considered aesthetic = 
elevated but direct.
Accessible price + everyday product = 
warm and punchy.

"Premium & Aspirational" →
Quiet confidence. The product doesn't 
need to shout.

"Bold & Direct" →
Short sentences. Strong verbs. 
No hedging.

"Warm & Conversational" →
A voice note from a friend with 
great taste.

"Minimal & Editorial" →
Every word earns its place.
Stark. Let the product breathe.

WHAT KILLS GOOD COPY:
- Starting with the brand or product name
- "Introducing" or "Meet the new"
- "Limited time" or "Don't miss"
- "You deserve" or "Treat yourself"
- Ending with "Follow us" or 
  "Follow for more"
- Three adjectives in a row
- Abstract cleverness that needs 
  interpretation
- Any sentence that works for 
  any other brand unchanged

WHAT MAKES GREAT COPY:
- A first sentence that creates a 
  specific image or feeling immediately
- One detail so specific it could only 
  describe this product
- A rhythm that feels natural read aloud
- An ending that feels inevitable
- Something that makes the reader 
  feel seen, not sold to

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

${imageUrl ? 
  `A product image has been provided. 
  Use what you observe — colour, style, 
  texture, mood, occasion-fit, aesthetic — 
  to inform the copy. Let the visual 
  truth of the product shape the writing 
  as much as the description does.` 
  : ""}`;

    const messageContent: any[] = [];

    if (imageUrl) {
      messageContent.push({
        type: "image",
        source: {
          type: "url",
          url: imageUrl,
        }
      });
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
    const textContent = message.content.find((block) => block.type === "text");
    if (!textContent || textContent.type !== "text") {
      throw new Error("No text content returned from Claude");
    }

    let parsedResponse;
    try {
      // Strip markdown code fences if Claude
      // wraps the JSON in json ... 
      const cleaned = textContent.text
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
