import { describe, expect, it } from "vitest";
import { validateFactualClaims } from "./factual-claims";
import { normalizeCopyPunctuation, validateCopy } from "./validate-copy";

describe("shared factual-claim validation", () => {
  it("requires the asserted material and purity, not another fabric", () => {
    expect(validateFactualClaims(["Cut from 100% linen."], {
      description: "A cotton shirt with a relaxed fit.",
    })).toContainEqual(expect.stringContaining('Unsupported factual claim: "100% linen"'));
    expect(validateFactualClaims(["Cut from 100% linen."], {
      title: "100% Linen Camp Shirt",
      description: "A relaxed fit.",
    })).toEqual([]);
  });

  it("requires the exact regulatory assertion and ignores negated evidence", () => {
    expect(validateFactualClaims(["FDA-approved and clinically proven."], {
      description: "Dermatologist-approved formula. Not FDA-approved.",
    })).toHaveLength(2);
    expect(validateFactualClaims(["FDA-approved formula."], {
      description: "FDA approved formula.",
    })).toEqual([]);
    expect(validateFactualClaims(["FDA-approved formula."], {
      description: "Gentle formula.",
      catalog_claims: "fda_approved: false",
    })).toHaveLength(1);
  });

  it("checks more than one distinct claim in a sentence", () => {
    const errors = validateFactualClaims(["Organic cotton, made in Italy, and award-winning."], {
      description: "Organic cotton shirt.",
    });
    expect(errors).toHaveLength(2);
    expect(errors.join(" ")).toContain("made in Italy");
    expect(errors.join(" ")).toContain("award-winning");
  });

  it("checks provenance claims beyond a short country list", () => {
    expect(validateFactualClaims(["Made in Nigeria."], {
      description: "Designed in Lagos and made in Ghana.",
    })).toContainEqual(expect.stringContaining('Unsupported factual claim: "Made in Nigeria"'));
  });

  it("also guards primary ad copy", () => {
    const errors = validateCopy({
      headline: "Clinically proven comfort",
      primaryText: "Made for a better day.",
      description: "A cotton essential.",
      cta: "Shop Now",
    }, "Cotton shirt with a relaxed fit.");
    expect(errors).toContainEqual(expect.stringContaining('Unsupported factual claim: "Clinically proven"'));
  });
});

describe("copy punctuation repair", () => {
  it("normalizes customer copy and preserves question marks", () => {
    const result = normalizeCopyPunctuation({
      headline: "An easy layer!!",
      primaryText: "Ready?! Wear it today!",
      primary_text: "Ready?! Wear it today!",
      description: "A calm finish...!",
      cta: "Shop Now",
    });
    expect(result).toMatchObject({
      headline: "An easy layer.",
      primaryText: "Ready? Wear it today.",
      primary_text: "Ready? Wear it today.",
      description: "A calm finish.",
    });
    expect(validateCopy(result, "An easy layer with a calm finish.")).not.toContain(
      "Exclamation mark detected — banned for premium copy",
    );
  });
});
