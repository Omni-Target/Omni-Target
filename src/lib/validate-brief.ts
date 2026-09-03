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
