import { describe, expect, it } from "vitest";
import { buildCopyValidationEvidence } from "./copy-evidence";
import { validateCopy } from "./validate-copy";

const copy = {
  headline: "A linen layer for slower days",
  primaryText: "Wear the 100% Linen Camp Shirt with the Ego Dress.",
  description: "An easy button-down for warm afternoons.",
  cta: "Shop Now",
};

describe("copy validation evidence", () => {
  it("allows catalog-backed materials and a sibling endorsed by the description", () => {
    const { groundedProductEvidence, forbiddenProductNames } = buildCopyValidationEvidence(
      {
        id: "shirt",
        name: "100% Linen Camp Shirt",
        description: "A breezy button-down. Pair with the Ego Dress.",
        tags: ["resortwear"],
      },
      [
        { id: "shirt", name: "100% Linen Camp Shirt" },
        { id: "dress", name: "Ego Dress" },
        { id: "bag", name: "City Tote" },
      ],
    );

    expect(forbiddenProductNames).toEqual(["City Tote"]);
    expect(validateCopy(copy, groundedProductEvidence, forbiddenProductNames)).toEqual([]);
  });

  it("still rejects an unrelated sibling product", () => {
    const { groundedProductEvidence, forbiddenProductNames } = buildCopyValidationEvidence(
      { id: "shirt", name: "Camp Shirt", description: "A relaxed cotton shirt." },
      [
        { id: "shirt", name: "Camp Shirt" },
        { id: "dress", name: "Ego Dress" },
      ],
    );
    const errors = validateCopy(
      { ...copy, headline: "The Camp Shirt", primaryText: "Try the Ego Dress too.", description: "A cotton layer." },
      groundedProductEvidence,
      forbiddenProductNames,
    );
    expect(errors).toContain('Sibling product reference detected: "Ego Dress"');
  });
});

describe("claim evidence rules (AI-02)", () => {
  const product = { id: "shirt", name: "Camp Shirt", description: "A relaxed everyday shirt." };
  const validate = (text: string, target: typeof product & { tags?: string[] }, claims = "") => {
    const { groundedProductEvidence, forbiddenProductNames, factualEvidence } = buildCopyValidationEvidence(
      target,
      [{ id: "shirt", name: "Camp Shirt" }],
      claims,
    );
    return validateCopy(
      { headline: "For slower days", primaryText: text, description: "An easy everyday layer.", cta: "Shop Now" },
      groundedProductEvidence,
      forbiddenProductNames,
      factualEvidence,
    );
  };

  it("rejects a 'Made in' claim with no product evidence, whatever country the store is in", () => {
    expect(validate("Made in Nigeria for slower days.", product).join(" ")).toContain("Made in Nigeria");
  });

  it("does not accept a tag as support for a material claim", () => {
    const errors = validate("Soft organic cotton for slower days.", { ...product, tags: ["organic cotton"] });
    expect(errors.join(" ").toLowerCase()).toContain("organic");
  });

  it("still accepts the same claims when the description or catalog claims state them", () => {
    expect(validate("Soft organic cotton for slower days.", { ...product, description: "Made from organic cotton." })).toEqual([]);
    expect(validate("Made in Nigeria for slower days.", product, "Made in Nigeria")).toEqual([]);
  });
});
