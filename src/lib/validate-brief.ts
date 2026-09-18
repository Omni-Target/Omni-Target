export interface TargetProductContext {
  id: string;
  title: string;
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

/**
 * Extracts specific, claim-bearing tokens from hook text — filtering out
 * generic fashion/copy vocabulary that legitimately recurs across hooks
 * without indicating conceptual overlap. Used for cross-hook overlap detection.
 */
function extractSalientTokens(text: string): Set<string> {
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
    "clothing", "garment", "outfit", "wearing", "wears", "model", "photo",
    "piece", "pieces", "items", "thing", "things", "scene", "close",
    "camera", "focus", "showing", "shows", "capture", "detail", "details",
  ]);

  const salient = new Set<string>();
  for (const token of tokenize(text)) {
    if (token.length > 4 && !stoplist.has(token)) {
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

  // 1. Enforce exactly 3 distinct angles
  const angles = response.creative_hooks?.map((h) => h.angle) || [];
  if (angles.length !== 3) {
    errors.push(`Expected exactly 3 creative hooks, received ${angles.length}`);
  }
  if (new Set(angles).size !== angles.length) {
    errors.push(`Duplicate angle detected: ${angles.join(", ")}`);
  }

  // 2. Cross-hook conceptual overlap detection
  // Compares the salient (claim-bearing) tokens across every hook pair.
  // Two hooks sharing 2+ salient tokens are centering on the same underlying
  // claim even if their angle enum labels differ — the threshold of 2 avoids
  // false positives from product-specific words that legitimately appear once.
  if ((response.creative_hooks?.length || 0) >= 2) {
    const hookProfiles = (response.creative_hooks || []).map((hook) => ({
      angle: hook.angle,
      salient: extractSalientTokens(
        `${hook.visual_cue || ""} ${hook.on_screen_text || ""} ${hook.primary_text_hook || ""}`
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

  // 2. Build target product token baseline (Title + Tags)
  const targetTokens = tokenize(
    `${targetProduct.title} ${targetProduct.tags?.join(" ") || ""}`
  );

  // 3. Filter sibling products dynamically (Token-Subset Exclusion)
  const verifiableSiblings = catalog.filter((sibling) => {
    if (
      sibling.id === targetProduct.id ||
      sibling.title.trim().toLowerCase() === targetProduct.title.trim().toLowerCase()
    ) {
      return false;
    }

    const siblingTokens = Array.from(tokenize(sibling.title));
    if (siblingTokens.length === 0) return false;

    // Exclude sibling if ALL of its tokens exist within the target's tokens (e.g., 'Noir' inside 'Ego Pants (Noir)')
    const isSubsetOfTarget = siblingTokens.every((token) =>
      targetTokens.has(token)
    );
    return !isSubsetOfTarget;
  });

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
  const targetTokens = tokenize(
    `${targetProduct.title} ${targetProduct.tags?.join(" ") || ""}`
  );

  const verifiableSiblings = catalog.filter((sibling) => {
    if (
      sibling.id === targetProduct.id ||
      sibling.title.trim().toLowerCase() === targetProduct.title.trim().toLowerCase()
    ) {
      return false;
    }
    const siblingTokens = Array.from(tokenize(sibling.title));
    if (siblingTokens.length === 0) return false;
    return !siblingTokens.every((token) => targetTokens.has(token));
  });

  const sanitizedHooks = (response.creative_hooks || []).map((hook) => {
    let visual_cue = hook.visual_cue || "";
    let on_screen_text = hook.on_screen_text || "";
    let primary_text_hook = hook.primary_text_hook || "";

    for (const sibling of verifiableSiblings) {
      // Escape the original sibling title for use as a regex pattern
      // e.g. "Ego Pants (Noir)" → /Ego Pants \(Noir\)/gi  — matches the literal parentheses
      const escapedTitle = sibling.title
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!escapedTitle) continue;

      const regex = new RegExp(escapedTitle, "gi");
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
