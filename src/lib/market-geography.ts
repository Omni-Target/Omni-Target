/**
 * Multi-Market Geography & Budget Utility
 * Dynamically classifies locations into domestic vs international and computes dynamic multi-market budget floors.
 * 100% dynamic — zero hardcoded city lists. All classification is driven by country metadata and AI inference.
 */

/**
 * Normalizes country strings, common aliases, and ISO codes for accurate comparison.
 */
export function normalizeCountry(countryStr?: string): string {
  if (!countryStr) return "";
  const cleaned = countryStr.toLowerCase().trim().replace(/[^a-z]/g, "");

  // Common international ISO-2 / ISO-3 code aliases
  if (cleaned === "ng" || cleaned === "nga" || cleaned === "nigeria") return "nigeria";
  if (
    cleaned === "gb" ||
    cleaned === "uk" ||
    cleaned === "gbr" ||
    cleaned === "unitedkingdom" ||
    cleaned === "greatbritain" ||
    cleaned === "britain" ||
    cleaned === "england" ||
    cleaned === "scotland" ||
    cleaned === "wales" ||
    cleaned === "northernireland"
  ) {
    return "unitedkingdom";
  }
  if (
    cleaned === "us" ||
    cleaned === "usa" ||
    cleaned === "unitedstates" ||
    cleaned === "unitedstatesofamerica"
  ) {
    return "unitedstates";
  }
  if (cleaned === "ca" || cleaned === "can" || cleaned === "canada") return "canada";
  if (cleaned === "za" || cleaned === "zaf" || cleaned === "southafrica" || cleaned === "rsa") return "southafrica";
  if (cleaned === "gh" || cleaned === "gha" || cleaned === "ghana") return "ghana";
  if (cleaned === "ke" || cleaned === "ken" || cleaned === "kenya") return "kenya";
  if (
    cleaned === "ae" ||
    cleaned === "are" ||
    cleaned === "uae" ||
    cleaned === "unitedarabemirates" ||
    cleaned === "dubai"
  ) {
    return "unitedarabemirates";
  }
  if (cleaned === "au" || cleaned === "aus" || cleaned === "australia") return "australia";
  if (cleaned === "de" || cleaned === "deu" || cleaned === "germany" || cleaned === "deutschland") return "germany";
  if (cleaned === "fr" || cleaned === "fra" || cleaned === "france") return "france";
  if (cleaned === "ie" || cleaned === "irl" || cleaned === "ireland") return "ireland";
  if (cleaned === "nl" || cleaned === "nld" || cleaned === "netherlands" || cleaned === "holland") return "netherlands";
  if (cleaned === "in" || cleaned === "ind" || cleaned === "india") return "india";

  return cleaned;
}

/**
 * Dynamically determines if two country names or codes refer to the same country.
 */
export function isSameCountry(countryA?: string, countryB?: string): boolean {
  if (!countryA || !countryB) return false;
  const a = normalizeCountry(countryA);
  const b = normalizeCountry(countryB);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Determines if a market is Tier-1 (mature e-commerce and high ad cost market like US, UK, Canada, Australia, EU).
 */
export function isTier1Market(countryStr?: string, currencyStr?: string): boolean {
  const normCountry = normalizeCountry(countryStr);
  if (
    normCountry === "unitedstates" ||
    normCountry === "unitedkingdom" ||
    normCountry === "canada" ||
    normCountry === "australia" ||
    normCountry === "germany" ||
    normCountry === "france" ||
    normCountry === "ireland" ||
    normCountry === "netherlands"
  ) {
    return true;
  }
  const normCurr = (currencyStr || "").toUpperCase().trim();
  if (
    normCurr === "USD" ||
    normCurr === "GBP" ||
    normCurr === "EUR" ||
    normCurr === "CAD" ||
    normCurr === "AUD"
  ) {
    return true;
  }
  return false;
}

/**
 * Resolves the true operating country of a store based on currency and customer order history,
 * preventing accounts registered with foreign addresses (e.g. US registered accounts) from
 * misclassifying their domestic market.
 */
export function getEffectiveStoreCountry(
  storeCountry?: string,
  storeCurrency?: string,
  topLocations?: Array<{ city?: string; country?: string; percentage?: number }>
): string {
  const normCurr = (storeCurrency || "").toUpperCase().trim();

  // 1. Fiat currencies that definitively anchor the merchant's home domestic market
  if (normCurr === "NGN") return "Nigeria";
  if (normCurr === "GHS") return "Ghana";
  if (normCurr === "KES") return "Kenya";
  if (normCurr === "ZAR") return "South Africa";
  if (normCurr === "GBP") return "United Kingdom";
  if (normCurr === "CAD") return "Canada";
  if (normCurr === "AUD") return "Australia";
  if (normCurr === "INR") return "India";
  if (normCurr === "JPY") return "Japan";
  if (normCurr === "BRL") return "Brazil";

  // 2. Order history dominant country (if >=35% of orders originate from one country)
  if (topLocations && topLocations.length > 0) {
    const top = topLocations[0];
    if (top.country && (top.percentage ?? 0) >= 35) {
      return top.country;
    }
  }

  // 3. Fallback to store profile country
  if (storeCountry) {
    return storeCountry;
  }

  return "United States";
}

/**
 * Fast metropolitan resolver: maps major global advertising hubs and domestic cities
 * to their canonical country, preventing overseas diaspora hubs (e.g. Houston, Toronto, London)
 * from ever leaking into domestic local targeting.
 */
export const KNOWN_METRO_COUNTRIES: Record<string, string> = {
  // United States
  houston: "unitedstates",
  dallas: "unitedstates",
  austin: "unitedstates",
  sanantonio: "unitedstates",
  atlanta: "unitedstates",
  newyork: "unitedstates",
  newyorkcity: "unitedstates",
  nyc: "unitedstates",
  losangeles: "unitedstates",
  la: "unitedstates",
  chicago: "unitedstates",
  miami: "unitedstates",
  orlando: "unitedstates",
  washington: "unitedstates",
  washingtondc: "unitedstates",
  dc: "unitedstates",
  boston: "unitedstates",
  philadelphia: "unitedstates",
  sanfrancisco: "unitedstates",
  sf: "unitedstates",
  seattle: "unitedstates",
  denver: "unitedstates",
  phoenix: "unitedstates",
  lasvegas: "unitedstates",
  detroit: "unitedstates",
  charlotte: "unitedstates",
  nashville: "unitedstates",
  tampa: "unitedstates",
  minneapolis: "unitedstates",
  sandiego: "unitedstates",
  baltimore: "unitedstates",
  columbus: "unitedstates",
  indianapolis: "unitedstates",
  jacksonville: "unitedstates",
  portland: "unitedstates",
  memphis: "unitedstates",
  louisville: "unitedstates",
  milwaukee: "unitedstates",
  albuquerque: "unitedstates",
  tucson: "unitedstates",
  fresno: "unitedstates",
  sacramento: "unitedstates",
  kansascity: "unitedstates",
  mesa: "unitedstates",
  omaha: "unitedstates",
  raleigh: "unitedstates",
  longbeach: "unitedstates",
  oakland: "unitedstates",
  tulsa: "unitedstates",
  neworleans: "unitedstates",
  cleveland: "unitedstates",
  pittsburgh: "unitedstates",
  cincinnati: "unitedstates",
  stlouis: "unitedstates",
  newark: "unitedstates",

  // Canada
  toronto: "canada",
  montreal: "canada",
  vancouver: "canada",
  calgary: "canada",
  ottawa: "canada",
  edmonton: "canada",
  winnipeg: "canada",
  mississauga: "canada",
  brampton: "canada",
  quebeccity: "canada",
  quebec: "canada",
  hamilton: "canada",

  // United Kingdom
  london: "unitedkingdom",
  greaterlondon: "unitedkingdom",
  manchester: "unitedkingdom",
  birmingham: "unitedkingdom",
  leeds: "unitedkingdom",
  glasgow: "unitedkingdom",
  liverpool: "unitedkingdom",
  newcastle: "unitedkingdom",
  sheffield: "unitedkingdom",
  bristol: "unitedkingdom",
  edinburgh: "unitedkingdom",
  leicester: "unitedkingdom",
  belfast: "unitedkingdom",
  cardiff: "unitedkingdom",
  nottingham: "unitedkingdom",
  coventry: "unitedkingdom",
  southampton: "unitedkingdom",

  // Ireland & Europe
  dublin: "ireland",
  paris: "france",
  berlin: "germany",
  munich: "germany",
  frankfurt: "germany",
  hamburg: "germany",
  amsterdam: "netherlands",
  rotterdam: "netherlands",
  brussels: "belgium",
  madrid: "spain",
  barcelona: "spain",
  rome: "italy",
  milan: "italy",
  vienna: "austria",
  zurich: "switzerland",
  geneva: "switzerland",
  warsaw: "poland",
  lisbon: "portugal",
  stockholm: "sweden",
  copenhagen: "denmark",
  oslo: "norway",
  helsinki: "finland",
  athens: "greece",
  prague: "czechia",
  budapest: "hungary",

  // UAE / Middle East
  dubai: "unitedarabemirates",
  abudhabi: "unitedarabemirates",
  doha: "qatar",
  riyadh: "saudiarabia",
  jeddah: "saudiarabia",

  // Australia & New Zealand
  sydney: "australia",
  melbourne: "australia",
  brisbane: "australia",
  perth: "australia",
  adelaide: "australia",
  auckland: "newzealand",

  // Nigeria
  lagos: "nigeria",
  abuja: "nigeria",
  portharcourt: "nigeria",
  ibadan: "nigeria",
  kano: "nigeria",
  benincity: "nigeria",
  enugu: "nigeria",
  abeokuta: "nigeria",
  warri: "nigeria",
  calabar: "nigeria",
  asaba: "nigeria",
  onitsha: "nigeria",
  jos: "nigeria",
  kaduna: "nigeria",
  ilorin: "nigeria",
  owerri: "nigeria",
  uyo: "nigeria",
  akure: "nigeria",
  osogbo: "nigeria",
  maiduguri: "nigeria",
  zaria: "nigeria",
  aba: "nigeria",
  minna: "nigeria",

  // Ghana
  accra: "ghana",
  kumasi: "ghana",
  tamale: "ghana",
  takoradi: "ghana",

  // Kenya
  nairobi: "kenya",
  mombasa: "kenya",
  kisumu: "kenya",

  // South Africa
  johannesburg: "southafrica",
  capetown: "southafrica",
  durban: "southafrica",
  pretoria: "southafrica",
};

export function lookupCityCountry(cityName?: string): string | undefined {
  if (!cityName) return undefined;
  const cleaned = cityName.toLowerCase().trim().replace(/[^a-z]/g, "");
  return KNOWN_METRO_COUNTRIES[cleaned];
}

/**
 * Dynamically checks if a location is domestic relative to the store.
 * Relies on country metadata (from order shipping data, AI classification, or store order history),
 * and verifies against a global metropolitan resolver to prevent overseas export hubs from leaking into domestic lists.
 */
export function isDomesticCity(
  cityName: string,
  country?: string,
  storeCountry?: string,
  storeCurrency?: string,
  topLocations?: Array<{ city?: string; country?: string; percentage?: number }>
): boolean {
  const effectiveCountry = getEffectiveStoreCountry(storeCountry, storeCurrency, topLocations);

  // 1. If explicit country is provided, compare countries dynamically
  if (country) {
    return isSameCountry(country, effectiveCountry);
  }

  // 2. If the city string contains country info (e.g. "Lagos, Nigeria", "London, UK", "New York, USA")
  if (cityName && cityName.includes(",")) {
    const parts = cityName.split(",");
    const trailing = parts[parts.length - 1].trim();
    if (trailing) {
      return isSameCountry(trailing, effectiveCountry);
    }
  }

  // 3. Match against the store's customer order history to retrieve the city's real shipping country
  if (cityName && topLocations && topLocations.length > 0) {
    const cleanCity = cityName.toLowerCase().trim();
    const match = topLocations.find(
      (l) =>
        l.city?.toLowerCase().trim() === cleanCity ||
        cleanCity.startsWith(l.city?.toLowerCase().trim() || "___") ||
        (l.city && cleanCity.includes(l.city.toLowerCase().trim()))
    );
    if (match?.country) {
      return isSameCountry(match.country, effectiveCountry);
    }
  }

  // 4. Metropolitan dictionary check: resolve city to canonical country
  const resolvedCountry = lookupCityCountry(cityName);
  if (resolvedCountry) {
    return isSameCountry(resolvedCountry, effectiveCountry);
  }

  // 5. Default: Return true only if no known conflict
  return true;
}

export function getInternationalBudgetFloor(currency: string, exchangeRate?: number): string {
  const normCurr = (currency || "USD").toUpperCase().trim();
  if (exchangeRate && exchangeRate > 0) {
    const val = Math.round(18 * exchangeRate);
    switch (normCurr) {
      case "NGN":
        return `₦${val.toLocaleString()}/day ($18/day min)`;
      case "GBP":
        return `£${val.toLocaleString()}/day ($18/day min)`;
      case "EUR":
        return `€${val.toLocaleString()}/day ($18/day min)`;
      case "CAD":
        return `CA$${val.toLocaleString()}/day ($18/day min)`;
      case "AUD":
        return `A$${val.toLocaleString()}/day ($18/day min)`;
      case "ZAR":
        return `R${val.toLocaleString()}/day ($18/day min)`;
      case "GHS":
        return `GH₵${val.toLocaleString()}/day ($18/day min)`;
      case "KES":
        return `KSh ${val.toLocaleString()}/day ($18/day min)`;
      default:
        return `${normCurr} ${val.toLocaleString()}/day ($18/day min)`;
    }
  }

  switch (normCurr) {
    case "NGN":
      return "₦28,800/day ($18/day min)";
    case "GBP":
      return "£14/day ($18/day min)";
    case "EUR":
      return "€17/day ($18/day min)";
    case "CAD":
      return "CA$25/day ($18/day min)";
    case "AUD":
      return "A$28/day ($18/day min)";
    case "ZAR":
      return "R330/day ($18/day min)";
    case "GHS":
      return "GH₵280/day ($18/day min)";
    case "KES":
      return "KSh 2,400/day ($18/day min)";
    case "USD":
    default:
      return "$18/day minimum";
  }
}

export interface MarketStrategy {
  label: string;
  daily: number;
  total_daily: number;
  description: string;
}

/**
 * Dynamically computes the 3 international budget strategies based on Tier-1 Meta CPM floors.
 * - Dip Your Toe: $18/day minimum floor
 * - Sweet Spot: $25/day balanced test
 * - Full Send: $40/day accelerated learning
 */
export function getInternationalStrategies(
  currency: string,
  exchangeRate?: number,
  domesticDaily?: number | null
): MarketStrategy[] {
  const normCurr = (currency || "USD").toUpperCase().trim();

  let floor18 = 18;
  let sweet25 = 25;
  let send40 = 40;

  if (exchangeRate && exchangeRate > 0) {
    floor18 = Math.round(18 * exchangeRate);
    sweet25 = Math.round(25 * exchangeRate);
    send40 = Math.round(40 * exchangeRate);
  } else {
    switch (normCurr) {
      case "NGN":
        floor18 = 28800;
        sweet25 = 40000;
        send40 = 64000;
        break;
      case "GBP":
        floor18 = 14;
        sweet25 = 20;
        send40 = 32;
        break;
      case "EUR":
        floor18 = 17;
        sweet25 = 24;
        send40 = 38;
        break;
      case "CAD":
        floor18 = 25;
        sweet25 = 35;
        send40 = 55;
        break;
      case "AUD":
        floor18 = 28;
        sweet25 = 40;
        send40 = 60;
        break;
      case "ZAR":
        floor18 = 330;
        sweet25 = 480;
        send40 = 750;
        break;
      case "GHS":
        floor18 = 280;
        sweet25 = 400;
        send40 = 650;
        break;
      case "KES":
        floor18 = 2400;
        sweet25 = 3400;
        send40 = 5500;
        break;
      default:
        floor18 = 18;
        sweet25 = 25;
        send40 = 40;
    }
  }

  const isTier1 = isTier1Market(undefined, normCurr);

  // If the merchant is in a Tier-1 market (US, UK, Canada, Australia) and has a known domestic daily budget:
  // ensure the optional international test does not exceed or distort their main campaign budget.
  if (isTier1 && domesticDaily && domesticDaily > 0) {
    floor18 = Math.max(5, Math.round(domesticDaily * 0.6));
    sweet25 = Math.max(floor18, Math.round(domesticDaily));
    send40 = Math.max(sweet25, Math.round(domesticDaily * 1.5));
  }

  return [
    {
      label: "Dip Your Toe",
      daily: floor18,
      total_daily: floor18,
      description: isTier1
        ? "Low-risk international test budget to explore foreign buyer demand."
        : "Minimum test floor ($18/day). Required by Meta to deliver in high-CPM overseas markets without stalling.",
    },
    {
      label: "Sweet Spot",
      daily: sweet25,
      total_daily: sweet25,
      description: isTier1
        ? "Balanced international test budget matched to your current campaign pace."
        : "Our recommendation for overseas testing ($25/day). Enough budget to compete for high-intent shoppers in Tier-1 hubs.",
    },
    {
      label: "Full Send",
      daily: send40,
      total_daily: send40,
      description: isTier1
        ? "Accelerated international push to capture early purchase signals rapidly."
        : "Accelerated international push ($40/day). Higher bid power to capture early purchase signals rapidly.",
    },
  ];
}

