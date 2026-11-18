import Anthropic from "@anthropic-ai/sdk";
export { ABUJA_AREAS, LAGOS_AREAS, PH_AREAS, consolidateLocation, formatCityName } from "./location-rules";

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
    await logApiUsage(userId ?? null, "location_consolidation", message.usage, message.model);

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

      return result;
    }
    return result;
  } catch (error) {
    console.error("AI location consolidation error:", error);
    return result;
  }
}
