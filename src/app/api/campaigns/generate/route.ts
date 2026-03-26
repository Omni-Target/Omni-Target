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
    } = body;

    // Validate required fields
    if (!brandName || !productName || !productDescription) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const systemPrompt = `You are an expert ad copywriter for fashion brands. 
You write Meta ad copy (Facebook and Instagram) 
that feels authentic to each specific brand.

You never use generic language. You read the 
brand context provided and write copy that sounds 
like IT came from that brand, not from a template.

RULES:
- Never use exclamation marks in headlines
- Never use "Limited Time" or "X% OFF" 
  unless the campaign goal is explicitly a sale
- Match the tone to the brand's audience and 
  tone preference
- If tone preference is "Let AI decide", 
  infer the right tone from the brand name, 
  product description, and target audience
- Write for Meta placements: 
  Facebook Feed and Instagram Feed

OUTPUT FORMAT — respond only with valid JSON, 
no markdown, no explanation, exactly this shape:
{
  "headline": "string (max 8 words)",
  "primaryText": "string (2-3 sentences, 
    the main ad body)",
  "description": "string (1 sentence, 
    shown below the headline on Facebook)",
  "cta": "string (one of: Shop Now, 
    Learn More, See Collection, 
    Get Offer, Sign Up)",
  "copywriterNote": "string (1 sentence 
    explaining the strategic choice 
    behind this copy — shown to the 
    founder so they understand WHY 
    this approach was taken)"
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
