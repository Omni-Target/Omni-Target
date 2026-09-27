import { validateFactualClaims, type ProductFactualEvidence } from "./factual-claims";

interface CopyOutput {
  headline?: string;
  primaryText?: string;
  primary_text?: string;
  description?: string;
  cta?: string;
  copywriterNote?: string;
}

/** Repair punctuation-only violations before spending tokens on a retry. */
export function normalizeCopyPunctuation<T extends CopyOutput>(copy: T): T {
  const normalized = { ...copy } as unknown as Record<string, unknown>;
  for (const field of ["headline", "primaryText", "primary_text", "description"]) {
    const value = normalized[field];
    if (typeof value === "string") {
      normalized[field] = value
        .replace(/\?+!+/g, "?")
        .replace(/!+(?=\?)/g, "")
        .replace(/!+/g, ".")
        .replace(/\.{2,}/g, ".");
    }
  }
  return normalized as T;
}

/**
 * Code-side enforcement of the rules the COPYWRITER_SYSTEM_PROMPT promises.
 *
 * Three passes:
 * 1. Banned string scan — catches exclamation marks, announcement clichés,
 *    unverified demand/scarcity claims, and universal fit assertions that the
 *    system prompt bans but previously had zero code enforcement behind them.
 * 2. Closure/material hallucination check — extracts verifiable product-fact
 *    terms (fabric types, closures, construction details) from the generated
 *    copy and confirms each one is present in the product evidence.
 * 3. Shared factual-claim validation — requires the exact material,
 *    certification, provenance, or commercial claim in product evidence.
 */
export function validateCopy(
  copy: CopyOutput,
  productDescription: string,
  forbiddenProductNames: string[] = [],
  factualEvidence?: ProductFactualEvidence,
): string[] {
  const errors: string[] = [];
  for (const field of ["headline", "primaryText", "description", "cta"] as const) {
    if (typeof copy[field] !== "string" || !copy[field]?.trim()) errors.push(`Missing ${field}`);
  }
  const allText = [copy.headline, copy.primaryText, copy.description]
    .filter((value) => typeof value === "string")
    .join(" ");

  for (const productName of forbiddenProductNames) {
    const normalized = productName.trim();
    if (normalized.length < 4) continue;
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(allText)) {
      errors.push(`Sibling product reference detected: "${normalized}"`);
    }
  }

  // ── Pass 1: Banned string patterns ──────────────────────────────────────
  const bannedPatterns: Array<{ pattern: RegExp; message: string }> = [
    { pattern: /!/,                                          message: "Exclamation mark detected — banned for premium copy" },
    { pattern: /\bIntroducing\b/i,                           message: "Banned announcement phrase: 'Introducing'" },
    { pattern: /\bMeet the\b/i,                              message: "Banned announcement phrase: 'Meet the'" },
    { pattern: /\bThe .{1,40} (is here|arrives|has arrived)\b/i, message: "Banned passive announcement headline" },
    { pattern: /\bflatters (all|every) body\b/i,             message: "Unverified universal fit claim" },
    { pattern: /\bmade for every body\b/i,                   message: "Unverified universal fit claim" },
    { pattern: /\bloved by thousands\b/i,                    message: "Unverified social proof claim" },
    { pattern: /\b(selling|sold) out fast\b/i,               message: "Unverified scarcity claim" },
    { pattern: /\bback by popular demand\b/i,                message: "Unverified demand claim" },
    { pattern: /\b(our |the )?fastest.selling\b/i,           message: "Unverified demand claim: 'fastest-selling'" },
    { pattern: /\bkeep(s)? selling out\b/i,                  message: "Unverified demand claim: 'keeps selling out'" },
    { pattern: /\balways sold out\b/i,                       message: "Unverified demand claim: 'always sold out'" },
    { pattern: /\bgame.?changer\b/i,                         message: "Banned cliché: 'game changer'" },
    { pattern: /\bElevate your\b/i,                          message: "Banned cliché: 'Elevate your'" },
    { pattern: /\bStep into\b/i,                             message: "Banned cliché: 'Step into'" },
    { pattern: /\bThere is a version of you\b/i,             message: "Banned abstract cliché" },
    { pattern: /\bImagine a world\b/i,                       message: "Banned abstract cliché" },
    { pattern: /\bLook no further\b/i,                       message: "Banned cliché: 'Look no further'" },
  ];

  for (const { pattern, message } of bannedPatterns) {
    if (pattern.test(allText)) {
      errors.push(message);
    }
  }

  // ── Pass 2: Closure & material hallucination check ───────────────────────
  // Terms that assert a specific, non-obvious material composition or closure.
  // Fit descriptors, styling suggestions, and generic properties (e.g. stretch,
  // unisex, adjustable, belt, pockets) are intentionally excluded so natural,
  // evocative copywriting is never falsely flagged.
  const verifiableTerms = [
    // Closures & fastenings
    "zipper", "zip", "drawstring", "elastic", "button", "buttons",
    "buckle", "velcro", "snap", "hook-and-eye", "lace-up",
    // Fabrics & materials
    "linen", "silk", "cotton", "wool", "cashmere", "satin", "chiffon",
    "velvet", "leather", "denim", "suede", "nylon", "polyester", "rayon",
    "viscose", "modal", "bamboo", "jersey", "tweed", "organza", "tulle",
    "crepe", "georgette", "brocade", "twill", "poplin",
    // Embellishments & specialized construction
    "embroidery", "embroidered", "beaded", "beading", "cowrie", "sequin",
    "sequined", "lace", "crochet", "smocking", "pleated", "pleats",
    "ruffle", "ruffles", "fringe", "tassels",
  ];

  const descLower = (productDescription || "").toLowerCase();
  const evidenceLower = [
    productDescription,
    factualEvidence?.title,
    ...(factualEvidence?.tags || []),
    factualEvidence?.product_type,
    factualEvidence?.catalog_claims,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const copyLower = allText.toLowerCase();

  const lemmaVariants: Record<string, string[]> = {
    zip: ["zip", "zipper", "zippers", "zipped"],
    zipper: ["zip", "zipper", "zippers", "zipped"],
    button: ["button", "buttons", "buttoned"],
    buttons: ["button", "buttons", "buttoned"],
    beaded: ["bead", "beads", "beaded", "beading"],
    beading: ["bead", "beads", "beaded", "beading"],
    embroidered: ["embroidery", "embroidered", "embroider"],
    embroidery: ["embroidery", "embroidered", "embroider"],
    pleats: ["pleat", "pleats", "pleated", "pleating"],
    pleated: ["pleat", "pleats", "pleated", "pleating"],
    ruffles: ["ruffle", "ruffles", "ruffled"],
    ruffle: ["ruffle", "ruffles", "ruffled"],
    sequin: ["sequin", "sequins", "sequined"],
    sequined: ["sequin", "sequins", "sequined"],
    elastic: ["elastic", "elasticated", "waistband", "smocked", "smocking", "stretch"],
  };

  const FABRIC_MATERIALS = new Set([
    "linen", "silk", "cotton", "wool", "cashmere", "satin", "chiffon",
    "velvet", "leather", "denim", "suede", "nylon", "polyester", "rayon",
    "viscose", "modal", "bamboo", "jersey", "tweed", "organza", "tulle",
    "crepe", "georgette", "brocade", "twill", "poplin",
  ]);

  function isFabricCompositionClaim(term: string, text: string): boolean {
    const pattern = new RegExp(
      `\\b(?:(?:cut|crafted|made|woven|tailored|stitched|spun)\\s+(?:from|in|with|of)\\s+(?:(?:pure|fine|raw|heavy|lightweight)\\s+)?${term}|(?:100%|pure|genuine|all)\\s+${term}|(?:our|this|the|a|an)\\s+${term}\\s+(?:dress|top|shirt|skirt|pant|pants|trousers|jacket|blazer|coat|robe|scarf|garment|piece|layer|wrap|set|suit|item|apparel|outfit|fabric|textile|material))\\b`,
      "i"
    );
    return pattern.test(text);
  }

  const NON_APPAREL_REGEX = /\b(?:coffee|tea|food|beverage|snack|skincare|serum|cream|cosmetic|makeup|beauty|fragrance|candle|soap|perfume|electronics|gadget|software|digital|book|audio)\b/i;
  const isNonApparel = NON_APPAREL_REGEX.test(
    `${factualEvidence?.product_type || ""} ${(factualEvidence?.tags || []).join(" ")} ${factualEvidence?.title || ""}`
  );

  for (const term of verifiableTerms) {
    const termRegex = new RegExp(`\\b${term}\\b`, "i");
    if (termRegex.test(copyLower)) {
      // If it's a fabric material, only flag when the copy asserts the product is composed of that fabric,
      // avoiding false positives on finish/texture metaphors (e.g. "satin finish", "velvety texture").
      if (FABRIC_MATERIALS.has(term) && !isFabricCompositionClaim(term, copyLower)) {
        continue;
      }
      // Non-apparel products (coffee, skincare, electronics, etc.) do not have garment closures/embellishments.
      if (isNonApparel && !FABRIC_MATERIALS.has(term)) {
        continue;
      }

      const allowedVariants = lemmaVariants[term] || [term];
      const isSupportedInDesc = allowedVariants.some((v) => new RegExp(`\\b${v}\\b`, "i").test(evidenceLower));
      if (!isSupportedInDesc) {
        // Check if it's used in a negative contrast context (e.g. "no polyester", "unlike synthetic polyester", "goodbye to polyester")
        const negativeContrastRegex = new RegExp(
          `\\b(?:not|no|never|unlike|without|instead of|goodbye to|ditch(?:ing)?|forget(?:ting)?|skip(?:s|ping)?|stop wearing|free of|zero)\\s+(?:(?:cheap|stiff|sweaty|synthetic|scratchy|heavy|plastic)\\s+)?${term}\\b`,
          "i"
        );
        if (!negativeContrastRegex.test(copyLower)) {
          errors.push(`Possible hallucination: "${term}" is in copy but not in product evidence`);
        }
      }
    }
  }

  errors.push(...validateFactualClaims(
    [copy.headline, copy.primaryText, copy.description]
      .filter((value): value is string => typeof value === "string"),
    factualEvidence ?? { description: productDescription },
  ));

  const factPatterns = [
    /\b(?:free (?:shipping|delivery|returns|exchanges)|lifetime guarantee|money[- ]back guarantee)\b/gi,
  ];
  const normalizedDescription = descLower.replace(/-/g, " ");

  for (const pattern of factPatterns) {
    for (const match of allText.matchAll(pattern)) {
      const matchNorm = match[0].toLowerCase().replace(/-/g, " ");
      if (!normalizedDescription.includes(matchNorm)) {
        errors.push(`Unsupported claim: "${match[0]}"`);
      }
    }
  }
  return errors;
}
