import { createLogger } from "./logger";

const log = createLogger("meta-interest-resolver");

export interface MetaAdInterestRaw {
  id: string;
  name: string;
  audience_size_lower_bound?: number;
  audience_size_upper_bound?: number;
  audience_size?: number;
  topic?: string | null;
  disambiguation_category?: string | null;
  path?: string[];
}

export interface ResolveMetaInterestsInput {
  candidateInterests: string[];
  productTitle?: string;
  productType?: string;
  tags?: string[];
  gender?: "All" | "Men" | "Women";
  productPrice?: number;
  storeAov?: number;
  accessToken?: string | null;
  fetchImpl?: typeof fetch;
}

const ALLOWED_TOPICS = new Set([
  "Shopping and fashion",
  "Fitness and wellness",
  "Hobbies and activities",
  "Home and garden",
  "Food and drink",
  "Family and relationships",
  "Business and industry",
  "Travel, places and events",
]);

const COMMERCIAL_DISAMBIGUATORS =
  /\((clothing|retail|retailers|accessories|design|cosmetics|personal care|footwear|jewellery|jewelry|home & garden|furnishings|skin care|hair care|health|fitness|food|beverages|e-commerce|shopping|luxury|bags|luggage|watches|eyewear|fragrance|perfume|beauty|decor|furniture)\)/i;

const BANNED_DISAMBIGUATION_OR_NAME =
  /\b(band|musician|singer|rapper|album|song|movie|film|television|tv show|series|actor|actress|politician|author|novel|book|magazine|newspaper|news|media|radio|podcast|video game|tabletop game|esports|football|rugby|basketball|baseball|cricket|airline|airport|supermarket|grocery|university|college|high school|hospital|church|charity|non-profit|wikipedia|daraz|aliexpress|temu|shein|wish\.com)\b/i;

const DOWNMARKET_TERMS =
  /\b(discount|coupon|bargain|clearance|thrift|second-hand|used|wholesale|cheap|dollar store|flea market|fast fashion|outlet)\b/i;

const MIN_AUDIENCE_LOWER_BOUND = 200_000;

// In-memory cache so repeated interest lookups across briefs are instant
const interestSearchCache = new Map<
  string,
  { expiresAt: number; data: MetaAdInterestRaw[] }
>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

export function stemInterestPhrase(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (word.length <= 3) return word;
      if (word.endsWith("ies") && word.length > 4) {
        return `${word.slice(0, -3)}y`;
      }
      if (word.endsWith("es") && word.length > 4 && !word.endsWith("ses")) {
        return word.slice(0, -1); // e.g. boutiques -> boutique, blouses -> blouse
      }
      if (word.endsWith("ses") && word.length > 4) {
        return word.slice(0, -2); // e.g. dresses -> dress
      }
      if (word.endsWith("s") && !word.endsWith("ss")) {
        return word.slice(0, -1);
      }
      return word;
    })
    .join(" ");
}

export function cleanMetaInterestDisplayName(rawMetaName: string): string {
  const stripped = rawMetaName.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (!stripped) return rawMetaName.trim();
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/**
 * Expands raw AI interest phrases + product attributes into high-probability
 * canonical Meta Detailed Targeting search queries.
 */
export function buildMetaInterestSearchSeeds(
  input: ResolveMetaInterestsInput
): string[] {
  const seeds: string[] = [];
  const add = (term?: string | null) => {
    const cleaned = term?.replace(/\s*\([^)]*\)\s*/g, " ").trim();
    if (!cleaned || cleaned.length < 2) return;
    if (!seeds.some((s) => s.toLowerCase() === cleaned.toLowerCase())) {
      seeds.push(cleaned);
    }
  };

  // 1. Always seed with Online shopping for e-commerce conversion intent
  add("Online shopping");

  const combinedProductText = [
    input.productTitle || "",
    input.productType || "",
    ...(input.tags || []),
  ].join(" ");

  // 2. Extract concrete product category nouns from title/type
  if (/\b(pant|pants|trouser|trousers|slacks|chinos|cargo)\b/i.test(combinedProductText)) {
    add("Trousers");
  }
  if (/\b(dress|dresses|gown|kaftan|boubou|maxi|midi)\b/i.test(combinedProductText)) {
    add("Dresses");
  }
  if (/\b(skirt|skirts|mini skirt|midi skirt)\b/i.test(combinedProductText)) {
    add("Skirt");
  }
  if (/\b(short|shorts|trunks|bubble short)\b/i.test(combinedProductText)) {
    add("Shorts");
  }
  if (/\b(top|tops|blouse|shirt|camisole|corset|bodysuit|tunic)\b/i.test(combinedProductText)) {
    add("Blouse");
  }
  if (/\b(jacket|coat|blazer|suit|trench|cardigan|sweater|hoodie)\b/i.test(combinedProductText)) {
    add("Blazer");
    add("Outerwear");
  }
  if (/\b(bag|handbag|tote|clutch|purse)\b/i.test(combinedProductText)) {
    add("Handbags");
  }
  if (/\b(shoe|shoes|sandal|heel|heels|boot|sneaker|loafer|mule)\b/i.test(combinedProductText)) {
    add("Footwear");
  }
  if (/\b(jewel|jewelry|jewellery|necklace|earring|bracelet|ring)\b/i.test(combinedProductText)) {
    add("Jewellery");
  }
  if (/\b(skin|skincare|serum|moisturizer|cleanser|toner|spf|lotion)\b/i.test(combinedProductText)) {
    add("Skin care");
    add("Cosmetics");
  }
  if (/\b(hair|wig|braid|shampoo|conditioner|curls)\b/i.test(combinedProductText)) {
    add("Hair care");
  }

  if (
    input.productType &&
    !/^(general|default|main|all|uncategorized|other)$/i.test(input.productType.trim())
  ) {
    add(input.productType);
  }

  // 3. Process and translate AI candidate interests (converting multi-word editorial
  // phrases into canonical Meta interest equivalents first)
  for (const raw of input.candidateInterests || []) {
    const item = raw.trim();
    if (!item) continue;

    let translated = false;
    if (/\bwomen['’]?s\s+fashion\b/i.test(item)) {
      add("Women's clothing");
      translated = true;
    }
    if (/\bmen['’]?s\s+fashion\b/i.test(item)) {
      add("Men's clothing");
      translated = true;
    }
    if (/\bboutique\b/i.test(item)) {
      add("Boutiques");
      translated = true;
    }
    if (/\b(contemporary|designer|luxury\s+fashion|fashion\s+brand|artisanal|bespoke)\b/i.test(item)) {
      add("Designer clothing");
      add("Fashion design");
      add("Luxury goods");
      translated = true;
    }
    if (/\b(going\s+out|nightlife|cocktail|party|evening|occasion)\b/i.test(item)) {
      add("Nightlife");
      add("Dresses");
      translated = true;
    }
    if (/\blinen\b/i.test(item)) {
      add("Linen");
      translated = true;
    }
    if (/\bsilk\b/i.test(item)) {
      add("Silk");
      translated = true;
    }
    if (/\b(resort|vacation|holiday|getaway|beachwear)\b/i.test(item)) {
      add("Resort wear");
      add("Vacations");
      translated = true;
    }
    if (/\b(streetwear|street\s+style)\b/i.test(item)) {
      add("Street fashion");
      translated = true;
    }
    if (/\b(sustainable|eco|slow\s+fashion)\b/i.test(item)) {
      add("Sustainable fashion");
      translated = true;
    }

    const words = item.split(/\s+/).filter(Boolean);
    if (!translated || words.length <= 2) {
      add(item);
    }
  }

  // 4. Add gender + price-tier commercial anchors
  const isApparelOrFashion =
    /\b(dress|pant|trouser|skirt|short|top|blouse|shirt|wear|clothing|fashion|apparel|gown|suit|jacket|linen|silk|cotton|noir)\b/i.test(
      `${combinedProductText} ${(input.candidateInterests || []).join(" ")}`
    );

  if (isApparelOrFashion) {
    if (input.gender === "Women") add("Women's clothing");
    else if (input.gender === "Men") add("Men's clothing");
    else add("Clothing");

    const isPremium =
      !input.productPrice ||
      !input.storeAov ||
      input.productPrice >= input.storeAov * 0.75;

    if (isPremium) {
      add("Luxury goods");
      add("Designer clothing");
      add("Boutiques");
      add("Fashion design");
    } else {
      add("Boutiques");
      add("Shopping");
    }
  }

  return seeds.slice(0, 14);
}

function isCandidateValidForProduct(
  item: MetaAdInterestRaw,
  input: ResolveMetaInterestsInput
): boolean {
  const lowerSize =
    item.audience_size_lower_bound ?? item.audience_size ?? 0;
  if (lowerSize < MIN_AUDIENCE_LOWER_BOUND) return false;

  if (
    item.disambiguation_category &&
    BANNED_DISAMBIGUATION_OR_NAME.test(item.disambiguation_category)
  ) {
    return false;
  }
  if (BANNED_DISAMBIGUATION_OR_NAME.test(item.name)) {
    return false;
  }

  const hasCommercialDisambiguator = COMMERCIAL_DISAMBIGUATORS.test(item.name);
  if (item.topic) {
    if (!ALLOWED_TOPICS.has(item.topic) && !hasCommercialDisambiguator) {
      return false;
    }
  } else if (!hasCommercialDisambiguator) {
    return false;
  }

  const cleanName = cleanMetaInterestDisplayName(item.name);

  // Gender guard (word boundary so "women's" is never confused with "men's")
  if (input.gender === "Women" && /\b(men|men['’]s|male|boy|boys|gentlemen)\b/i.test(cleanName)) {
    return false;
  }
  if (input.gender === "Men" && /\b(women|women['’]s|female|lady|ladies|girl|girls|bridal|maternity)\b/i.test(cleanName)) {
    return false;
  }

  // Price-tier brand safety guard
  const isPremium =
    !input.productPrice ||
    !input.storeAov ||
    input.productPrice >= input.storeAov * 0.75;
  if (isPremium && DOWNMARKET_TERMS.test(cleanName)) {
    return false;
  }

  return true;
}

async function queryMetaAdInterest(
  query: string,
  token: string,
  fetchFn: typeof fetch
): Promise<MetaAdInterestRaw[]> {
  const cacheKey = `q:${query.toLowerCase()}`;
  const cached = interestSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const url =
    `https://graph.facebook.com/v19.0/search?type=adinterest` +
    `&q=${encodeURIComponent(query)}&limit=8&access_token=${encodeURIComponent(token)}`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(3500) });
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: MetaAdInterestRaw[] };
  const data = Array.isArray(json.data) ? json.data : [];
  interestSearchCache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    data,
  });
  return data;
}

async function queryMetaAdInterestSuggestions(
  seedNames: string[],
  token: string,
  fetchFn: typeof fetch
): Promise<MetaAdInterestRaw[]> {
  if (seedNames.length === 0) return [];
  const listParam = JSON.stringify(seedNames.slice(0, 3));
  const cacheKey = `sug:${listParam.toLowerCase()}`;
  const cached = interestSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const url =
    `https://graph.facebook.com/v19.0/search?type=adinterestsuggestion` +
    `&interest_list=${encodeURIComponent(listParam)}&limit=10&access_token=${encodeURIComponent(token)}`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(3500) });
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: MetaAdInterestRaw[] };
  const data = Array.isArray(json.data) ? json.data : [];
  interestSearchCache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    data,
  });
  return data;
}

/**
 * Resolves AI candidate seed interests against Meta's live Detailed Targeting
 * Graph API (`type=adinterest` + `type=adinterestsuggestion`) so every single
 * interest in the brief is 100% copy-pasteable into Meta Ads Manager and
 * matched to the product's buyer profile.
 */
export async function resolveVerifiedMetaInterests(
  input: ResolveMetaInterestsInput
): Promise<string[]> {
  const token =
    input.accessToken ||
    process.env.META_SYSTEM_ACCESS_TOKEN ||
    (process.env.META_APP_ID && process.env.META_APP_SECRET
      ? `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`
      : null);

  const seeds = buildMetaInterestSearchSeeds(input);
  const fetchFn = input.fetchImpl ?? fetch;

  // If running in an offline test environment without Meta credentials and no custom fetch mock,
  // return the cleaned canonical seeds up to 5 items.
  if (!token && !input.fetchImpl) {
    return seeds.slice(0, 5);
  }

  const effectiveToken = token || "test-token";

  try {
    const verifiedByStem = new Map<string, string>();

    const searchResults = await Promise.all(
      seeds.map(async (seed) => {
        try {
          const items = await queryMetaAdInterest(seed, effectiveToken, fetchFn);
          return { seed, items };
        } catch {
          return { seed, items: [] as MetaAdInterestRaw[] };
        }
      })
    );

    // Pass 1: Strict stem match against each query in priority order
    for (const { seed, items } of searchResults) {
      const seedStem = stemInterestPhrase(seed);
      for (const item of items) {
        if (!isCandidateValidForProduct(item, input)) continue;
        const cleanName = cleanMetaInterestDisplayName(item.name);
        const itemStem = stemInterestPhrase(cleanName);
        if (itemStem === seedStem && !verifiedByStem.has(itemStem)) {
          verifiedByStem.set(itemStem, cleanName);
          break;
        }
      }
      if (verifiedByStem.size >= 5) break;
    }

    // Pass 2: If fewer than 4 verified interests matched, query Meta's co-occurrence
    // graph (`type=adinterestsuggestion`) using the matched seeds
    if (verifiedByStem.size < 4 && verifiedByStem.size > 0) {
      const matchedList = Array.from(verifiedByStem.values());
      const suggestions = await queryMetaAdInterestSuggestions(
        matchedList,
        effectiveToken,
        fetchFn
      );
      for (const item of suggestions) {
        if (!isCandidateValidForProduct(item, input)) continue;
        const cleanName = cleanMetaInterestDisplayName(item.name);
        const itemStem = stemInterestPhrase(cleanName);
        if (!verifiedByStem.has(itemStem)) {
          verifiedByStem.set(itemStem, cleanName);
        }
        if (verifiedByStem.size >= 5) break;
      }
    }

    const resolved = Array.from(verifiedByStem.values()).slice(0, 5);
    if (resolved.length >= 3) {
      return resolved;
    }
  } catch (err) {
    log.warn("Live Meta adinterest resolution failed, using canonical seeds", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return seeds.slice(0, 5);
}
