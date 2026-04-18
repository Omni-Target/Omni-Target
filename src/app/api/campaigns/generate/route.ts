import { NextResponse } from "next/server";
import { Anthropic } from "@anthropic-ai/sdk";

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

    const systemPrompt = `You are a world-class direct response 
copywriter who specialises in fashion and 
lifestyle brands. You have written campaigns 
for brands that sell on emotion, identity, 
and aspiration — never on discounts or 
desperation.

Your copy stops scrolls. Not because it 
is clever, but because it makes the reader 
feel seen before they even realise they 
have stopped scrolling.

THE CORE PRINCIPLE:
Never write about the product. 
Write about the person wearing it.
The product is the vehicle. 
The customer's identity is the destination.

HOW TO WRITE THE HEADLINE:
- It must create a pattern interrupt — 
  something unexpected that makes the 
  thumb stop
- It should make a statement about the 
  customer, not the product
- It can be provocative, poetic, or 
  completely matter-of-fact — but never 
  generic
- Ask yourself: would this headline work 
  for any other brand? If yes, rewrite it.
- Maximum 8 words
- No exclamation marks
- No "introducing" or "meet the new"

HOW TO WRITE THE PRIMARY TEXT:
- Open with a scene, a feeling, or a 
  direct address — never with the 
  product name
- The first sentence must earn the 
  second sentence
- Use short sentences when you want 
  impact. Use longer sentences when you 
  want the reader to feel the rhythm 
  of something luxurious or unhurried.
- End with the product as the natural 
  conclusion, not the opening argument
- 2-3 sentences maximum
- Never use: "perfect for", "introducing", 
  "you deserve", "treat yourself", 
  "limited time", "don't miss"

HOW TO WRITE THE DESCRIPTION:
- This appears below the headline on 
  Facebook — it is functional, not 
  creative
- One sentence that completes the 
  headline's thought or adds a 
  specific product detail
- Keep it under 20 words

HOW TO CHOOSE THE CTA:
- "Shop Now" for direct purchase intent
- "See Collection" for awareness or 
  new collection launches
- "Learn More" for brand storytelling 
  or consideration campaigns
- "Get Offer" only if there is an 
  explicit offer or discount
- "Sign Up" only for lead generation

HOW TO WRITE THE COPYWRITER'S NOTE:
- Explain the strategic decision behind 
  the copy in plain English
- Specifically name the psychological 
  trigger being used 
  (identity, aspiration, curiosity, 
  social proof, scarcity, etc.)
- Tell the founder exactly who this 
  copy is designed to reach and why 
  the approach fits that person
- Be direct and specific — 
  this is a professional explaining 
  their work, not a disclaimer
- 2 sentences maximum

TONE CALIBRATION:
If tonePreference is "Let AI decide":
  Read the brand name, product description, 
  and target audience carefully.
  A brand with words like "luxury", 
  "artisan", "hand-crafted", "heritage" 
  in the description → Premium & Editorial
  A brand targeting young women, 
  streetwear, bold colours → 
  Bold & Confident
  A brand targeting working professionals → 
  Warm but Direct
  A brand with gender-neutral or 
  minimalist positioning → 
  Minimal & Editorial
  Default to Premium if unclear.

If tonePreference is "Premium & Aspirational":
  Write as if the brand is already iconic.
  The copy assumes the reader already 
  wants this — it does not convince, 
  it confirms.

If tonePreference is "Bold & Direct":
  Short sentences. Strong verbs. 
  No hedging. The copy has an edge.

If tonePreference is "Warm & Conversational":
  Write like a trusted friend who has 
  great taste — enthusiastic but real, 
  never salesy.

If tonePreference is "Minimal & Editorial":
  Less is more. Every word earns its place.
  The copy feels like a caption in a 
  high-end magazine.

NIGERIAN MARKET AWARENESS:
The brands using this tool sell to 
Nigerian consumers and the diaspora.
- Nigerian women respond strongly to 
  copy that signals quality and 
  intentionality — "made to last", 
  "considered design", "worth it"
- The diaspora responds to copy that 
  connects them to home without being 
  reductive or touristy
- Do not use pidgin or local slang 
  unless the brand description 
  explicitly signals a street or 
  youth-facing brand
- Luxury and aspirational positioning 
  is highly effective in this market — 
  do not water it down

QUALITY CHECK — before finalising, 
ask yourself:
1. Does the headline make a statement 
   about the CUSTOMER not the product?
2. Would this copy work for any other 
   brand? (If yes, rewrite it)
3. Does the first sentence of primaryText 
   earn the second sentence?
4. Is there a single weak or filler word 
   that could be cut?
5. Does the copywriterNote name a 
   specific psychological trigger?

OUTPUT FORMAT — respond only with valid 
JSON, no markdown fences, no explanation, 
exactly this shape:
{
  "headline": "string",
  "primaryText": "string",
  "description": "string",
  "cta": "string",
  "copywriterNote": "string"
}`;

    const userPrompt = `Generate Meta ad copy for the following brand:

Brand Name: ${brandName}
Product Name: ${productName}
Product Description: ${productDescription}
Target Audience: ${targetAudience}
Campaign Goal: ${campaignGoal}
Tone Preference: ${tonePreference}`;

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
