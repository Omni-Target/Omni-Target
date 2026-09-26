import { validateCopy } from "./campaigns/validate-copy";
export { validateFactualClaims } from "./campaigns/factual-claims";
export interface TargetProductContext {
  id: string;
  title: string;
  description?: string;
  tags?: string[];
  product_type?: string;
  price?: number | string;
  url?: string;
}

export interface CatalogItem {
  id: string;
  title: string;
}

export interface CreativeHookResponse {
  angle: string;
  visual_cue: string;
  on_screen_text: string;
  primary_text_hook: string;
}

export interface GeneratedBriefResponse {
  target_product_title: string;
  creative_hooks: CreativeHookResponse[];
  locations?: Array<{
    name: string;
    source: "from_data" | "recommended";
    percentage?: number | null;
    note?: string;
  }>;
  demographics?: {
    gender: "All" | "Men" | "Women";
    demographic_justification: string;
    age_min: number;
    age_max: number;
    age_reasoning: string;
  };
  seed_interests?: string[];
  optimization_reasoning?: string;
  timing?: {
    peak_days: string[];
    launch_recommendation: string;
    reasoning: string;
  };
}

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1)
  );
}

function siblingTitlePattern(title: string): RegExp | null {
  const words = title.toLowerCase().match(/[a-z0-9]+/g);
  if (!words?.length) return null;
  return new RegExp(`\\b${words.join("[^a-z0-9]+")}\\b`, "gi");
}

export function getForbiddenSiblingProducts(
  targetProduct: TargetProductContext,
  catalog: CatalogItem[],
): CatalogItem[] {
  const targetTokens = tokenize(`${targetProduct.title} ${targetProduct.tags?.join(" ") || ""}`);
  const targetDescLower = (targetProduct.description || "").toLowerCase();
  return catalog.filter((sibling) => {
    if (
      sibling.id === targetProduct.id ||
      sibling.title.trim().toLowerCase() === targetProduct.title.trim().toLowerCase()
    ) return false;
    const siblingTitle = sibling.title.trim().toLowerCase();
    if (siblingTitle.length >= 3 && targetDescLower.includes(siblingTitle)) return false;
    const siblingTokens = Array.from(tokenize(sibling.title));
    return siblingTokens.length > 0 && !siblingTokens.every((token) => targetTokens.has(token));
  });
}

function productEvidenceDescription(
  targetProduct: TargetProductContext,
  catalog: CatalogItem[],
): string {
  let description = targetProduct.description || "";
  const targetTokens = tokenize(targetProduct.title);
  for (const sibling of catalog) {
    if (sibling.id === targetProduct.id ||
        sibling.title.trim().toLowerCase() === targetProduct.title.trim().toLowerCase()) continue;
    const words = Array.from(tokenize(sibling.title));
    if (words.length === 0 || words.every((word) => targetTokens.has(word))) continue;
    const pattern = siblingTitlePattern(sibling.title);
    if (pattern) description = description.replace(pattern, " ");
  }
  return description;
}

/**
 * Extracts specific, claim-bearing tokens from hook text — filtering out
 * generic fashion/copy vocabulary that legitimately recurs across hooks
 * without indicating conceptual overlap. Used for cross-hook overlap detection.
 */
function extractSalientTokens(text: string, productTokens?: Set<string>): Set<string> {
  // Words that are too generic to signal overlap — common across all fashion copy
  const stoplist = new Set([
    // Common English function words
    "that", "this", "with", "from", "your", "their", "they", "have",
    "will", "been", "what", "when", "where", "which", "there", "about",
    "just", "more", "into", "some", "than", "then", "them", "these",
    "would", "could", "should", "every", "after", "before", "never",
    "while", "still", "again", "always", "often", "built", "comes",
    // Generic product / fashion copy words
    "dress", "wear", "style", "look", "feel", "piece", "design", "built",
    "made", "perfect", "first", "time", "shop", "brand", "collection",
    "women", "woman", "fashion", "product", "quality", "premium", "those",
    "beautiful", "stunning", "elegant", "classic", "modern", "right",
    "best", "good", "great", "real", "true", "pure", "bold", "soft",
    "warm", "cool", "light", "dark", "rich", "deep", "long", "short",
    "wide", "slim", "open", "close", "free", "love", "life", "body",
    "hand", "work", "back", "side", "line", "form", "face", "keep",
    "make", "take", "move", "come", "goes", "know", "show", "find",
    "like", "need", "want", "give", "meet", "turn", "high", "last",
    "next", "same", "most", "only", "even", "also", "both", "each",
    "many", "much", "once", "here", "very", "well", "over", "ever",
    "clothing", "garment", "outfit", "wearing", "wears", "wearer", "model", "photo",
    "piece", "pieces", "items", "thing", "things", "scene", "close",
    "camera", "focus", "showing", "shows", "capture", "detail", "details",
    // Common garment types and styling words that legitimately recur
    "pants", "pant", "trousers", "trouser", "shirt", "shirts", "skirt", "skirts",
    "top", "tops", "shorts", "tee", "tees", "blouse", "blouses", "jeans",
    "fabric", "fabrics", "material", "materials", "natural", "everyday", "daily",
    "comfort", "comfortable", "silhouette", "crafted", "craft", "finish", "fitting",
    "relax", "relaxed", "linen", "cotton", "denim", "leather", "wool", "silk",
    "breathable", "cowrie", "waistband", "elastic", "oversized", "unisex", "beaded",
    "elevated", "styling", "handcrafted", "handmade", "simple", "season", "rotation",
    "staple", "staples", "favorite", "favorites", "texture", "details",
  ]);

  const salient = new Set<string>();
  for (const token of tokenize(text)) {
    if (token.length > 4 && !stoplist.has(token) && (!productTokens || !productTokens.has(token))) {
      salient.add(token);
    }
  }
  return salient;
}

/**
 * Validates a generated Advantage+ single-SKU brief response against
 * angle uniqueness, target product title drift, and sibling SKU leaks.
 */
export function validateBrief(
  response: GeneratedBriefResponse,
  targetProduct: TargetProductContext,
  catalog: CatalogItem[]
): string[] {
  const errors: string[] = [];
  if (!response || !Array.isArray(response.creative_hooks) ||
      response.creative_hooks.some((hook) =>
        !hook || typeof hook !== "object" ||
        [hook.angle, hook.visual_cue, hook.on_screen_text, hook.primary_text_hook]
          .some((field) => typeof field !== "string" || !field.trim())
      )) {
    return ["Creative hooks are missing or malformed"];
  }
  if (typeof response.target_product_title !== "string" || !response.target_product_title.trim()) {
    errors.push("Target product title is missing");
  }
  const evidenceDescription = productEvidenceDescription(targetProduct, catalog);

  // Normalize exclamation marks on hooks into calm, premium punctuation
  for (const hook of response.creative_hooks || []) {
    if (hook.on_screen_text) {
      hook.on_screen_text = hook.on_screen_text.replace(/!+/g, ".").replace(/\.\.+/g, ".");
    }
    if (hook.primary_text_hook) {
      hook.primary_text_hook = hook.primary_text_hook.replace(/!+/g, ".").replace(/\.\.+/g, ".");
    }
  }

  const factualEvidence = {
    title: targetProduct.title,
    description: evidenceDescription,
    tags: targetProduct.tags || [],
    product_type: targetProduct.product_type || "",
  };
  const hookEvidence = [
    factualEvidence.title,
    factualEvidence.description,
    ...factualEvidence.tags,
    factualEvidence.product_type,
  ].join(" ");
  for (const hook of response.creative_hooks || []) {
    errors.push(
      ...validateCopy(
        {
          headline: hook.on_screen_text,
          primaryText: hook.primary_text_hook,
          description: "Elevated staple.", // Neutral placeholder so visual_cue is not judged as consumer ad copy
          cta: "Shop Now",
        },
        hookEvidence,
        [],
        factualEvidence,
      ).map((error) => `Hook ${hook.angle}: ${error}`)
    );
  }

  // 1. Enforce exactly 3 distinct angles
  const angles = response.creative_hooks?.map((h) => h.angle) || [];
  if (angles.length !== 3) {
    errors.push(`Expected exactly 3 creative hooks, received ${angles.length}`);
  }
  if (new Set(angles).size !== angles.length) {
    errors.push(`Duplicate angle detected: ${angles.join(", ")}`);
  }

  const allProductTokens = tokenize(
    `${targetProduct.title} ${targetProduct.tags?.join(" ") || ""} ${evidenceDescription}`
  );
  // 2. Cross-hook customer-facing claim overlap detection.
  // Director notes describe camera treatment rather than ad claims.
  // Uses allProductTokens (including description) so legitimate product attributes
  // (e.g. linen, cowrie, breathable) don't trigger false overlap errors between hooks.
  if ((response.creative_hooks?.length || 0) >= 2) {
    const hookProfiles = (response.creative_hooks || []).map((hook) => ({
      angle: hook.angle,
      salient: extractSalientTokens(
        `${hook.on_screen_text || ""} ${hook.primary_text_hook || ""}`,
        allProductTokens
      ),
    }));

    for (let i = 0; i < hookProfiles.length; i++) {
      for (let j = i + 1; j < hookProfiles.length; j++) {
        const shared: string[] = [];
        for (const token of hookProfiles[i].salient) {
          if (hookProfiles[j].salient.has(token)) shared.push(token);
        }
        if (shared.length >= 2) {
          errors.push(
            `Hooks "${hookProfiles[i].angle}" and "${hookProfiles[j].angle}" share overlapping claims [${shared.slice(0, 4).join(", ")}]. Regenerate one using a genuinely distinct angle that does not centre on these terms.`
          );
        }
      }
    }
  }

  // 3. Filter sibling products dynamically (Token-Subset Exclusion & Description Reference Exclusion)
  const verifiableSiblings = getForbiddenSiblingProducts(targetProduct, catalog);

  // 4. Scan generated creative hooks for sibling title leaks
  for (const hook of response.creative_hooks || []) {
    // Normalize hook text so parentheses/punctuation don't bypass the regex
    // e.g. "Ego Pants (Noir)" → "ego pants  noir " which matches pattern "ego pants\s+noir"
    const hookText = `${hook.visual_cue || ""} ${hook.on_screen_text || ""} ${
      hook.primary_text_hook || ""
    }`
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ");

    for (const sibling of verifiableSiblings) {
      const sanitizedTitle = sibling.title
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .trim()
        .replace(/\s+/g, "\\s+");

      if (!sanitizedTitle) continue;

      const regex = new RegExp(`\\b${sanitizedTitle}\\b`, "i");
      if (regex.test(hookText)) {
        errors.push(`Hook "${hook.angle}" leaked sibling SKU: "${sibling.title}"`);
        break;
      }
    }
  }

  // 5. Target product drift check
  if (
    response.target_product_title &&
    response.target_product_title.trim().toLowerCase() !==
      targetProduct.title.trim().toLowerCase()
  ) {
    errors.push(
      `Product drift: expected "${targetProduct.title}", received "${response.target_product_title}"`
    );
  }

  return errors;
}

/**
 * Sanitizes any leaked sibling token in the hooks by replacing with target product title.
 */
export function sanitizeLeakedTokens(
  response: GeneratedBriefResponse,
  targetProduct: TargetProductContext,
  catalog: CatalogItem[]
): GeneratedBriefResponse {
  const verifiableSiblings = getForbiddenSiblingProducts(targetProduct, catalog);

  const sanitizedHooks = (response.creative_hooks || []).map((hook) => {
    let visual_cue = hook.visual_cue || "";
    let on_screen_text = (hook.on_screen_text || "").replace(/!+/g, ".").replace(/\.\.+/g, ".");
    let primary_text_hook = (hook.primary_text_hook || "").replace(/!+/g, ".").replace(/\.\.+/g, ".");

    for (const sibling of verifiableSiblings) {
      // Match the same title words across spaces or punctuation.
      const regex = siblingTitlePattern(sibling.title);
      if (!regex) continue;
      visual_cue = visual_cue.replace(regex, targetProduct.title);
      on_screen_text = on_screen_text.replace(regex, targetProduct.title);
      primary_text_hook = primary_text_hook.replace(regex, targetProduct.title);
    }

    return {
      ...hook,
      visual_cue,
      on_screen_text,
      primary_text_hook,
    };
  });

  return {
    ...response,
    target_product_title: targetProduct.title,
    creative_hooks: sanitizedHooks,
  };
}

/** A final gate shared by every hook generation route. */
export function finalizeCreativeHooks(
  response: GeneratedBriefResponse,
  targetProduct: TargetProductContext,
  catalog: CatalogItem[],
): GeneratedBriefResponse | null {
  if (!response || !Array.isArray(response.creative_hooks) ||
      response.creative_hooks.some((hook) =>
        !hook || typeof hook !== "object" ||
        [hook.angle, hook.visual_cue, hook.on_screen_text, hook.primary_text_hook]
          .some((field) => typeof field !== "string")
      ) || typeof response.target_product_title !== "string" ||
      response.target_product_title.trim().toLowerCase() !== targetProduct.title.trim().toLowerCase()) return null;
  // Replacing a sibling inside public copy can turn "Pair with X" into a
  // nonsensical self-reference. Use the verified fallback for that case.
  const forbiddenSiblings = getForbiddenSiblingProducts(targetProduct, catalog);
  const customerCopyHasSibling = response.creative_hooks.some((hook) =>
    forbiddenSiblings.some((sibling) => {
      const pattern = siblingTitlePattern(sibling.title);
      return pattern?.test(`${hook.on_screen_text} ${hook.primary_text_hook}`) || false;
    })
  );
  if (customerCopyHasSibling) return null;
  const sanitized = sanitizeLeakedTokens(response, targetProduct, catalog);
  return validateBrief(sanitized, targetProduct, catalog).length === 0
    ? sanitized
    : null;
}

const VERIFIED_FEATURES = [
  { pattern: /\bcowrie\b/i, label: "cowrie details" },
  { pattern: /\bhand[- ]beaded\b/i, label: "hand-beaded details" },
  { pattern: /\bembroider(?:y|ed)\b/i, label: "embroidered details" },
  { pattern: /\bpleat(?:s|ed)?\b/i, label: "pleated details" },
  { pattern: /\blinen\b/i, label: "linen fabric" },
  { pattern: /\bcotton\b/i, label: "cotton fabric" },
  { pattern: /\bsilk\b/i, label: "silk fabric" },
  { pattern: /\bdenim\b/i, label: "denim fabric" },
  { pattern: /\bwool\b/i, label: "wool fabric" },
  { pattern: /\bleather\b/i, label: "leather material" },
  { pattern: /\bpockets?\b/i, label: "pocket details" },
  { pattern: /\bwaistband\b/i, label: "waistband details" },
  { pattern: /\bzipper\b/i, label: "zipper details" },
  { pattern: /\bbuttons?\b/i, label: "button details" },
];

/** Construct conservative hooks only when the merchant supplied a usable product fact. */
export function buildVerifiedFallbackHooks(
  targetProduct: TargetProductContext,
  catalog: CatalogItem[],
): CreativeHookResponse[] | null {
  const description = productEvidenceDescription(targetProduct, catalog).replace(/<[^>]*>/g, " ");
  const feature = VERIFIED_FEATURES.find(({ pattern }) => {
    const match = pattern.exec(description);
    if (!match) return false;
    const precedingWords = description.slice(Math.max(0, match.index - 35), match.index);
    return !/\b(?:without|no|not|unlike|free of|instead of)\s+(?:\w+\s+){0,2}$/i.test(precedingWords);
  });
  if (!feature || !targetProduct.title.trim()) return null;

  const title = targetProduct.title;
  const candidate: GeneratedBriefResponse = {
    target_product_title: title,
    creative_hooks: [
      {
        angle: "Problem / Friction",
        visual_cue: `Show ${title} in a simple everyday styling scene.`,
        on_screen_text: "A closer look at the details.",
        primary_text_hook: `Looking for a fresh approach to your daily look? Explore ${title}.`,
      },
      {
        angle: "Identity / Status",
        visual_cue: `Show ${title} from several angles in natural light.`,
        on_screen_text: "Style it your way.",
        primary_text_hook: `Make ${title} part of a look that feels like yours.`,
      },
      {
        angle: "Material / Craftsmanship",
        visual_cue: `Film a close-up of the ${feature.label} on ${title}.`,
        on_screen_text: `${feature.label} in focus.`,
        primary_text_hook: `Take a closer look at the ${feature.label} on ${title}.`,
      },
    ],
  };
  return validateBrief(candidate, targetProduct, catalog).length === 0
    ? candidate.creative_hooks
    : null;
}
