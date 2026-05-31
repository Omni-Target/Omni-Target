import Anthropic from "@anthropic-ai/sdk";

export const LAGOS_AREAS = [
  "ikoyi", "lekki", "victoria island", "vi", "surulere", "yaba", "ikeja",
  "ajah", "festac", "gbagada", "maryland", "mushin", "agege", "isale eko",
  "lagos island", "apapa", "magodo", "ojodu", "ojota", "oshodi", "palmgrove",
  "ikorodu", "epe", "badagry", "alagbado", "alimosho", "bariga", "ebute metta",
  "egbeda", "ejigbo", "idimu", "ikotun", "ilupeju", "ipaja", "isolo", "ketu",
  "mile 12", "ogba", "okota", "orile", "osapa", "shomolu"
];

export const ABUJA_AREAS = [
  "maitama", "wuse", "garki", "asokoro", "gwarinpa", "kubwa", "lugbe", "jabi",
  "utako", "gudu", "life camp", "apo", "karu", "nyanya", "lokogoma", "galadimawa",
  "guzape", "durumi", "fct", "abuja"
];

export const PH_AREAS = [
  "gra port harcourt", "trans amadi", "rumuola", "rumuokoro", "eleme", "choba",
  "diobu", "borokiri", "ph", "port harcourt", "port-harcourt"
];

export function consolidateLocation(city: string): string {
  if (!city) return "Unknown";
  
  const clean = city.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, " ").replace(/\s+/g, " ").trim();
  const cityLower = clean.toLowerCase();
  
  // 1. Lagos check: If it matches or contains "lagos", or is in LAGOS_AREAS, or matches any LAGOS_AREAS as a word
  if (cityLower.includes("lagos")) {
    return "Lagos";
  }
  for (const area of LAGOS_AREAS) {
    if (cityLower === area || cityLower.includes(` ${area}`) || cityLower.includes(`${area} `)) {
      return "Lagos";
    }
  }

  // 2. Abuja check: If it matches or contains "abuja" or "fct", or is in ABUJA_AREAS
  if (cityLower.includes("abuja") || cityLower.includes("fct")) {
    return "Abuja";
  }
  for (const area of ABUJA_AREAS) {
    if (cityLower === area || cityLower.includes(` ${area}`) || cityLower.includes(`${area} `)) {
      return "Abuja";
    }
  }

  // 3. Port Harcourt check: If contains "port harcourt" or matches PH areas
  if (cityLower.includes("port harcourt") || cityLower.includes("port-harcourt") || cityLower === "ph") {
    return "Port Harcourt";
  }
  for (const area of PH_AREAS) {
    if (cityLower === area || cityLower.includes(` ${area}`) || cityLower.includes(`${area} `)) {
      return "Port Harcourt";
    }
  }

  // 4. Benin City check
  if (cityLower.includes("benin") || cityLower.includes("oredo")) {
    return "Benin City";
  }

  // 5. Ibadan check
  if (cityLower.includes("ibadan") || cityLower.includes("bodija") || cityLower.includes("oluyole")) {
    return "Ibadan";
  }

  // 6. Warri check
  if (cityLower.includes("warri") || cityLower.includes("effurun")) {
    return "Warri";
  }

  // 7. Enugu check
  if (cityLower.includes("enugu")) {
    return "Enugu";
  }

  // 8. Kaduna check
  if (cityLower.includes("kaduna")) {
    return "Kaduna";
  }

  // 9. Kano check
  if (cityLower.includes("kano")) {
    return "Kano";
  }

  // 10. Calabar check
  if (cityLower.includes("calabar")) {
    return "Calabar";
  }

  // 11. Uyo check
  if (cityLower.includes("uyo")) {
    return "Uyo";
  }

  // 12. Owerri check
  if (cityLower.includes("owerri")) {
    return "Owerri";
  }

  // 13. Ilorin check
  if (cityLower.includes("ilorin")) {
    return "Ilorin";
  }

  // 14. Jos check
  if (cityLower.includes("jos")) {
    return "Jos";
  }

  // 15. Asaba check
  if (cityLower.includes("asaba")) {
    return "Asaba";
  }

  // 16. Akure check
  if (cityLower.includes("akure")) {
    return "Akure";
  }

  // 17. Abeokuta check
  if (cityLower.includes("abeokuta")) {
    return "Abeokuta";
  }

  // Standard formatting for other cities to make sure they are beautifully title-cased
  return clean
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

const anthropicClient = new Anthropic();

import { logApiUsage } from "@/lib/db";

export async function consolidateLocationsWithAI(
  rawLocations: { city: string; country: string }[],
  userId?: string | null
): Promise<Record<string, string>> {
  if (rawLocations.length === 0) return {};

  const prompt = `
You are an address consolidation API for a Shopify store.
Your task is to take a list of raw city/country names from customer orders, and for the primary market (especially Nigeria), group/consolidate all sub-city neighborhoods, local government areas (LGAs), or districts into their standard parent metropolitan city or state (e.g. Lekki, Ikoyi, Ikeja, Victoria Island, Yaba -> Lagos; Maitama, Wuse, Gwarinpa, Kubwa -> Abuja; GRA, Trans Amadi -> Port Harcourt; Benin City -> Benin City).

For other markets, consolidate them into their standard city or state name (e.g. "Detroit, MI" -> "Detroit", "London, Greater London" -> "London").

Clean any extra whitespaces, commas, or province abbreviations from the final name, and ensure proper Title Case.

Input locations:
${JSON.stringify(rawLocations, null, 2)}

Return ONLY a valid JSON object mapping the exact raw city input to its consolidated parent city or state name. No explanations, no markdown block.
Example format:
{
  "Lekki": "Lagos",
  "Wuse": "Abuja",
  "Benin City": "Benin City"
}
`;

  try {
    const message = await anthropicClient.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text.trim() : "";
    const cleanText = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    
    const parsed = JSON.parse(cleanText) as Record<string, string>;
    if (typeof parsed === "object" && parsed !== null) {
      if (userId) {
        logApiUsage(
          userId,
          "location_consolidation",
          message.usage.input_tokens,
          message.usage.output_tokens
        );
      }
      return parsed;
    }
    return {};
  } catch (error) {
    console.error("AI location consolidation error:", error);
    return {};
  }
}
