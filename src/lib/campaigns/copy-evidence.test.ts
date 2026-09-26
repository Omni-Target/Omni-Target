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
