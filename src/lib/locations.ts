import Anthropic from "@anthropic-ai/sdk";
import { normalizeCountry } from "./market-geography";

export const LAGOS_AREAS = [
  "ikoyi", "lekki", "victoria island", "vi", "surulere", "yaba", "ikeja",
  "ajah", "festac", "gbagada", "maryland", "mushin", "agege", "isale eko",
  "lagos island", "apapa", "magodo", "ojodu", "ojota", "oshodi", "palmgrove",
  "ikorodu", "epe", "badagry", "alagbado", "alimosho", "bariga", "ebute metta",
  "egbeda", "ejigbo", "idimu", "ikotun", "ilupeju", "ipaja", "isolo", "ketu",
  "mile 12", "ogba", "okota", "orile", "osapa", "shomolu",
  // Lekki axis sub-neighborhoods
  "ikate", "ikate elegushi", "sangotedo", "agungi", "oniru", "jakande",
  "ologolo", "ilasan", "idado", "igbo efon", "chevron", "marwa", "ikota",
  "awoyaya", "ibeju lekki", "kekki", "eti osa",
  // Island & waterfront
  "banana island", "obalende",
  // Mainland extensions
  "ojo", "mile 2", "ogudu", "alapere", "omole", "berger", "ojodu berger",
  "aguda", "anthony", "cement", "alausa", "oregun", "opebi", "allen",
  "igando", "iyana ipaja", "abule egba", "ajao", "amuwo odofin",
];

export const ABUJA_AREAS = [
  "maitama", "wuse", "garki", "asokoro", "gwarinpa", "gwarimpa", "kubwa", "lugbe", "jabi",
  "utako", "gudu", "life camp", "apo", "karu", "nyanya", "lokogoma", "galadimawa",
  "guzape", "durumi", "katampe", "fct", "abuja"
];

export const PH_AREAS = [
  "gra port harcourt", "trans amadi", "rumuola", "rumuokoro", "eleme", "choba",
  "diobu", "borokiri", "ph", "port harcourt", "port-harcourt"
];

const NIGERIAN_METROS: { city: string; terms: string[]; exact?: string[] }[] = [
  { city: "Lagos", terms: ["lagos", ...LAGOS_AREAS] },
  { city: "Abuja", terms: ABUJA_AREAS },
  { city: "Port Harcourt", terms: [...PH_AREAS, "rivers"] },
  { city: "Benin City", terms: ["benin", "oredo"] },
  { city: "Ibadan", terms: ["ibadan", "bodija", "oluyole", "oyo state"], exact: ["oyo"] },
  { city: "Warri", terms: ["warri", "effurun"] },
  { city: "Enugu", terms: ["enugu"] },
  { city: "Kaduna", terms: ["kaduna"] },
  { city: "Kano", terms: ["kano"] },
  { city: "Calabar", terms: ["calabar"] },
  { city: "Uyo", terms: ["uyo"] },
  { city: "Owerri", terms: ["owerri"] },
  { city: "Ilorin", terms: ["ilorin"] },
  { city: "Jos", terms: ["jos"] },
  { city: "Asaba", terms: ["asaba"] },
  { city: "Akure", terms: ["akure"] },
  { city: "Abeokuta", terms: ["abeokuta"] },
];

/** Whole-word match, so "riverside" is not "rivers" and "san jose" is not "jos". */
const hasTerm = (text: string, term: string) => ` ${text} `.includes(` ${term} `);

/**
 * Maps a raw city to its parent metro using static rules for the order's own
 * country (GEO-01). Nigerian rules apply only to Nigerian orders and the
 * London rule only to UK orders, so Riverside, CA is never Port Harcourt.
 * Returns null when no rule applies, including for an unknown country, so the
 * AI tier can attempt resolution with the country in context.
 */
export function consolidateLocation(city: string, country: string | null | undefined): string | null {
  if (!city) return null;

  const clean = city.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, " ").replace(/\s+/g, " ").trim();
  const cityLower = clean.toLowerCase();
  const market = normalizeCountry(country ?? "");

  if (market === "unitedkingdom") {
    return cityLower === "england" || hasTerm(cityLower, "london") ? "London" : null;
  }
  if (market !== "nigeria") return null;

  for (const metro of NIGERIAN_METROS) {
    if (metro.exact?.includes(cityLower) || metro.terms.some((term) => hasTerm(cityLower, term))) {
      return metro.city;
    }
  }
  return null;
}

/**
 * Title-cases a city name for clean display.
 * Used as the final fallback when neither static nor AI resolution matches.
 */
export function formatCityName(city: string): string {
  if (!city) return "Unknown";
  return city
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
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
