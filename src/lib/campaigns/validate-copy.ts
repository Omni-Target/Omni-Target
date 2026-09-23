interface CopyOutput {
  headline?: string;
  primaryText?: string;
  description?: string;
  cta?: string;
  copywriterNote?: string;
}

/**
 * Code-side enforcement of the rules the COPYWRITER_SYSTEM_PROMPT promises.
 *
 * Two passes:
 * 1. Banned string scan — catches exclamation marks, announcement clichés,
 *    unverified demand/scarcity claims, and universal fit assertions that the
 *    system prompt bans but previously had zero code enforcement behind them.
 * 2. Closure/material hallucination check — extracts verifiable product-fact
 *    terms (fabric types, closures, construction details) from the generated
 *    copy and confirms each one is present in the product description. A term
 *    in the copy that isn't in the description is a hallucination risk.
 */
export function validateCopy(
  copy: CopyOutput,
  productDescription: string,
  forbiddenProductNames: string[] = [],
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
  // Terms that are specific and verifiable — if the copy claims them, they
  // must appear in the product description. Generic words (dress, style, etc.)
  // are intentionally excluded from this list.
  const verifiableTerms = [
    // Closures & fastenings
    "zipper", "zip", "drawstring", "elastic", "button", "buttons",
    "buckle", "velcro", "snap", "hook-and-eye", "lace-up", "belt", "sash",
    // Fabrics & materials
    "linen", "silk", "cotton", "wool", "cashmere", "satin", "chiffon",
    "velvet", "leather", "denim", "suede", "nylon", "polyester", "rayon",
    "viscose", "modal", "bamboo", "jersey", "tweed", "organza", "tulle",
    "crepe", "georgette", "brocade", "twill", "poplin",
    // Embellishments & construction
    "embroidery", "embroidered", "beaded", "beading", "cowrie", "sequin",
    "sequined", "lace", "crochet", "smocking", "pleated", "pleats",
    "ruffle", "ruffles", "fringe", "tassels", "pockets",
    // Specific fit/construction claims
    "unisex", "genderless", "adjustable", "stretch", "lined", "lining",
  ];

  const descLower = (productDescription || "").toLowerCase();
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
    lining: ["line", "lined", "lining", "linings"],
    lined: ["line", "lined", "lining", "linings"],
    pocket: ["pocket", "pockets"],
    pockets: ["pocket", "pockets"],
    elastic: ["elastic", "elasticated", "waistband"],
  };

  for (const term of verifiableTerms) {
    const termRegex = new RegExp(`\\b${term}\\b`, "i");
    if (termRegex.test(copyLower)) {
      const allowedVariants = lemmaVariants[term] || [term];
      const isSupportedInDesc = allowedVariants.some((v) => new RegExp(`\\b${v}\\b`, "i").test(descLower));
      if (!isSupportedInDesc) {
        // Check if it's used in a negative contrast context (e.g. "no polyester", "unlike synthetic polyester", "goodbye to polyester")
        const negativeContrastRegex = new RegExp(
          `\\b(?:not|no|never|unlike|without|instead of|goodbye to|ditch(?:ing)?|forget(?:ting)?|stop wearing|free of|zero)\\s+(?:(?:cheap|stiff|sweaty|synthetic|scratchy|heavy|plastic)\\s+)?${term}\\b`,
          "i"
        );
        if (!negativeContrastRegex.test(copyLower)) {
          errors.push(`Possible hallucination: "${term}" is in copy but not in product description`);
        }
      }
    }
  }

  const factPatterns = [
    /\bhand[- ](?:made|crafted|sewn|beaded|woven|finished)\b/gi,
    /\b(?:free (?:shipping|delivery|returns|exchanges)|lifetime guarantee|money[- ]back guarantee)\b/gi,
    /\b(?:made|manufactured) in [a-z]+\b/gi,
  ];
  const normalizedDescription = descLower.replace(/-/g, " ");
  const hasHandCraftsmanshipEvidence =
    /\bhand[- ](?:made|crafted|sewn|beaded|woven|finished|stitched|pleated|dyed|painted)\b/i.test(descLower) ||
    /\b(?:handmade|handcrafted|artisan|artisanal)\b/i.test(descLower);

  for (const pattern of factPatterns) {
    for (const match of allText.matchAll(pattern)) {
      const matchNorm = match[0].toLowerCase().replace(/-/g, " ");
      const isHandClaim = matchNorm.startsWith("hand ");
      if (isHandClaim && hasHandCraftsmanshipEvidence) {
        continue;
      }
      if (!normalizedDescription.includes(matchNorm)) {
        errors.push(`Unsupported claim: "${match[0]}"`);
      }
    }
  }
  return errors;
}
