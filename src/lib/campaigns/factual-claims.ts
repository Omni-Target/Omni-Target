export interface ProductFactualEvidence {
  title?: string;
  description: string;
  tags?: string[];
  product_type?: string;
  catalog_claims?: string;
}

// These phrases assert a specific material, provenance, certification, or
// commercial fact. Match the whole claim against product evidence: finding
// "cotton" must never substantiate "100% linen", for example.
const FACTUAL_CLAIM_PATTERNS: RegExp[] = [
  /\b(?:100%|pure|genuine|real)\s+(?:leather|silk|cotton|linen|wool|cashmere|suede)\b/gi,
  /\bhand[- ]?(?:made|crafted|stitched|sewn|woven|painted|dyed|beaded|finished)\b/gi,
  /\b(?:organic|vegan|cruelty[- ]?free|eco[- ]?friendly|sustainable|fair[- ]?trade|recyclable|biodegradable)(?:\s+(?:leather|silk|cotton|linen|wool|cashmere|suede))?\b/gi,
  /\b(?:medical[- ]?grade|clinical(?:ly)?[- ]?(?:tested|proven)|dermatologist[- ]?(?:tested|approved|recommended)|FDA[- ]?approved)\b/gi,
  /\b(?:patented|award[- ]?winning|best[- ]?selling|number one)\b|#1\b/gi,
  /\b(?:made|manufactured) in (?:the )?(?:united states|united kingdom|[a-z]+)\b/gi,
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-–—]/g, " ")
    .replace(/\bhand\s+(made|crafted|stitched|sewn|woven|painted|dyed|beaded|finished)\b/g, "hand$1")
    .replace(/[^a-z0-9#%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasPositiveEvidence(corpus: string, claim: string): boolean {
  const phrase = normalize(claim);
  if (!phrase) return false;
  let start = 0;
  while ((start = corpus.indexOf(phrase, start)) !== -1) {
    const before = corpus.slice(0, start);
    const after = corpus.slice(start + phrase.length);
    const bounded = (start === 0 || before.endsWith(" ")) && (!after || after.startsWith(" "));
    const negated = /(?:^|\s)(?:not|no|never|without)\s+(?:\w+\s+){0,2}$/.test(before);
    const deniedValue = /^\s+(?:false|no|not|0)(?:\s|$)/.test(after);
    if (bounded && !negated && !deniedValue) return true;
    start += phrase.length;
  }
  return false;
}

/** Check only customer-facing text against the selected product's evidence. */
export function validateFactualClaims(
  copyTexts: string[],
  evidence: ProductFactualEvidence,
): string[] {
  const evidenceSources = [
    evidence.title,
    evidence.description,
    ...(evidence.tags || []),
    evidence.product_type,
    evidence.catalog_claims,
  ].filter((source): source is string => typeof source === "string" && !!source.trim())
    .map(normalize);
  const errors: string[] = [];
  const reported = new Set<string>();

  for (const text of copyTexts) {
    for (const pattern of FACTUAL_CLAIM_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const claim = match[0];
        const key = normalize(claim);
        if (!reported.has(key) && !evidenceSources.some((source) => hasPositiveEvidence(source, claim))) {
          errors.push(`Unsupported factual claim: "${claim}" — not found in the selected product's evidence. Remove or rephrase.`);
          reported.add(key);
        }
      }
    }
  }
  return errors;
}
