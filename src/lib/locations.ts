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

// In-memory cache to prevent duplicate AI calls for identical location strings within the process
const locationMemoryCache = new Map<string, string>();

export async function consolidateLocationsWithAI(
  rawLocations: { city: string; country: string }[],
  userId?: string | null
): Promise<Record<string, string>> {
  if (rawLocations.length === 0) return {};

  const result: Record<string, string> = {};
  const uncachedLocations: { city: string; country: string }[] = [];

  for (const loc of rawLocations) {
    const key = loc.city.trim().toLowerCase();
    if (locationMemoryCache.has(key)) {
      result[loc.city.trim()] = locationMemoryCache.get(key)!;
    } else {
      uncachedLocations.push(loc);
    }
  }

  // If all requested locations were already resolved in cache, return immediately
  if (uncachedLocations.length === 0) {
    return result;
  }

  const prompt = `You are an address consolidation API for an e-commerce store.
Group sub-city neighborhoods, LGAs, or districts into standard parent metro cities (e.g. Lekki, Ikoyi, Ikeja, Yaba -> Lagos; Maitama, Wuse -> Abuja; Trans Amadi -> Port Harcourt; Detroit, MI -> Detroit; London, Greater London -> London).
Clean extra spaces and province abbreviations. Return proper Title Case.

Input:
${JSON.stringify(uncachedLocations, null, 2)}

Return ONLY a JSON object mapping raw city to consolidated city. No markdown blocks.
Example: {"Lekki": "Lagos", "Wuse": "Abuja"}`;

  try {
    const message = await anthropicClient.messages.create({
      model: "claude-haiku-4-5",
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
      for (const [rawCity, consolidatedCity] of Object.entries(parsed)) {
        result[rawCity] = consolidatedCity;
        locationMemoryCache.set(rawCity.trim().toLowerCase(), consolidatedCity);
      }

      if (userId) {
        logApiUsage(
          userId,
          "location_consolidation",
          message.usage.input_tokens,
          message.usage.output_tokens
        );
      }
      return result;
    }
    return result;
  } catch (error) {
    console.error("AI location consolidation error:", error);
    return result;
  }
}
