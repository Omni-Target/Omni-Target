/**
 * Static, country-aware city rules (GEO-01). Pure: the commerce importer uses
 * these without the AI fallback in locations.ts, which re-exports them.
 */
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
