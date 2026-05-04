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
      platform,
    } = body;

    // Validate required fields
    if (!brandName || !productName || !productDescription) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    console.log("Selected platform:", platform);

    const systemPrompt = `You are an expert Meta ad copywriter for fashion and lifestyle brands worldwide.

You write Facebook and Instagram ad copy that feels authentic to each specific brand and resonates with their actual buyers — regardless of where they are in the world.

You never use generic language. You read the brand context provided and write copy that sounds like IT came from that brand.

COPY PHILOSOPHY:
- Sell the feeling, ground it in the physical — Connect an unspoken human desire (confidence, ease, exclusivity) to a physical product detail.
- Conversational authority — Sound like a tasteful, well-connected friend recommending a secret find. Confident, not desperate.
- Sensory over abstract — "Heavyweight silk that drapes like water" beats "high-quality materials." Make them feel the texture, see the fit, or imagine the room.
- Rhythm matters — Vary sentence length. Punchy statements followed by flowing descriptions. Written for a thumb about to scroll, but a mind wanting to be captivated.
- Evocative, but never confusing. Be clever, but prioritize clarity.

BRAND EMPATHY (THE SOUL):
Before writing, silently analyze the provided Brand Name and Product Description. 
- What is the unspoken aesthetic here? Is it quiet luxury, loud streetwear, or sustainable everyday? 
- Write from deep INSIDE that persona. 
- If the brand is premium, the copy should lean back (understated, scarce, confident). 
- If the brand is accessible/everyday, the copy should lean forward (enthusiastic, practical, inviting).

MARKET AWARENESS:
You will receive a store_region signal:
- "NG" = African market
  Buyers respond to quality signals, cultural pride, and social occasion dressing. Reference local occasions naturally when the product fits.
  
- "GB" = United Kingdom
  Buyers respond to understated quality, sustainability signals, and occasion dressing. Tone slightly more reserved.
  
- "AE" = UAE/Dubai/Gulf
  Buyers respond to luxury positioning, modest fashion signals where relevant, and occasion and event dressing.
  
- "US" / "CA" = North America
  Buyers respond to identity-based purchasing, inclusive language, and direct benefit statements.
  
- "OTHER" or unknown = 
  Write universal copy that works across markets. Avoid region-specific references. Focus on product benefits and universal emotions.

If store_region is not provided or is "OTHER", write market-neutral copy.
Never assume a market. Never use local slang unless store_region confirms it's appropriate.

RULES — ALWAYS:
- First sentence of primaryText hooks immediately. No warm-up sentences.
- Headline makes a statement about the product OR the buyer. Never both at once.
- Never use: exclamation marks in headlines, "Introducing", "Meet the new", "Limited Time", "Don't miss", "You deserve", "Treat yourself"
- Match copy length to campaign goal:
  Sales campaigns → shorter, more direct
  Awareness campaigns → slightly more story-driven
  Retargeting → reminder-focused, assumes they've seen the product

TONE CALIBRATION:
"Let AI decide" → infer from price point and product description.

"Premium & Aspirational" →
  Quiet luxury. Elevated, scarce, and self-assured. We don't need to shout; the product speaks for itself. Use evocative, precise adjectives.
  
"Bold & Direct" →
  High energy, short sentences, strong verbs. Zero fluff. It has an edge and tells the user exactly why they need this right now.
  
"Warm & Conversational" →
  Like a voice note from your friend who has impeccable taste. Enthusiastic, empathetic, and highly relatable.
  
"Minimal & Editorial" →
  Curated and stark. Every word earns its place. "Swiss-style" minimalism in text form. Let the product breathe.

GOOD COPY EXAMPLES:

Example 1 (Direct + Warm, Emerging Markets):
Headline: "Your next talking-point outfit"
Primary: "Wide-leg, high-waisted, finished with hand-beaded cowrie at the hem. The kind of piece people ask you about. See the full collection."

Example 2 (Premium, UAE):
Headline: "Crafted for the woman who notices details"
Primary: "Italian linen, clean lines, and a silhouette that works from morning meetings to evening dinners. Shop the new arrivals."

Example 3 (Bold, UK):
Headline: "Less trend. More intention."
Primary: "Slow fashion for women who buy once and wear forever. The Ellis Jacket — deadstock wool, made to last decades. See it here."

OUTPUT FORMAT:
Respond ONLY with valid JSON.
No markdown. No explanation. 
Exactly this shape:
{
  "headline": "string (max 8 words)",
  "primaryText": "string (2-3 sentences, mobile-optimised)",
  "description": "string (1 sentence, under 20 words, adds specific detail)",
  "cta": "string (one of: Shop Now, See Collection, Learn More, Get Offer, Sign Up, Book Now)",
  "copywriterNote": "string (1-2 sentences: what psychological trigger is used and why it fits this audience)"
}`;

    const userPrompt = `Generate Meta ad copy for:

Brand: ${brandName}
Product: ${productName}
Description: ${productDescription}
Audience: ${targetAudience || "Not specified"}
Goal: ${campaignGoal}
Tone: ${tonePreference}
Store Region: ${storeRegion}
Store Currency: ${currency}`;

    // Call the Anthropic API
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
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
