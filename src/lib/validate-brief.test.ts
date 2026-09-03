import { describe, it, expect } from "vitest";
import {
  validateBrief,
  sanitizeLeakedTokens,
  type TargetProductContext,
  type CatalogItem,
  type GeneratedBriefResponse,
} from "./validate-brief";

describe("validateBrief", () => {
  const targetProduct: TargetProductContext = {
    id: "prod-1",
    title: "Ego Pants (Noir)",
    tags: ["pants", "bottoms", "streetwear", "noir"],
  };

  const catalog: CatalogItem[] = [
    { id: "prod-1", title: "Ego Pants (Noir)" },
    { id: "prod-2", title: "Noir" }, // subset of target product tokens
    { id: "prod-3", title: "Silk Blazer" }, // genuine sibling
    { id: "prod-4", title: "Velvet Hoodie" }, // genuine sibling
  ];

  it("passes when all 3 angles are distinct, target title matches, and no sibling leaked", () => {
    const response: GeneratedBriefResponse = {
      target_product_title: "Ego Pants (Noir)",
      creative_hooks: [
        {
          angle: "Problem / Friction",
          visual_cue: "Macro shot of durable double-stitched seams on the Ego Pants",
          on_screen_text: "Built to last every wear.",
          primary_text_hook: "Stop replacing pants every season.",
        },
        {
          angle: "Identity / Status",
          visual_cue: "Urban editorial model styled in the Ego Pants",
          on_screen_text: "Clean silhouette, zero compromise.",
          primary_text_hook: "Upgrade your daily rotation.",
        },
        {
          angle: "Material / Craftsmanship",
          visual_cue: "Close-up showing the heavyweight Noir cotton texture",
          on_screen_text: "Heavyweight premium weave.",
          primary_text_hook: "Feel the weight of real craftsmanship.",
        },
      ],
    };

    const errors = validateBrief(response, targetProduct, catalog);
    expect(errors).toEqual([]);
  });

  it("flags duplicate angles", () => {
    const response: GeneratedBriefResponse = {
      target_product_title: "Ego Pants (Noir)",
      creative_hooks: [
        {
          angle: "Problem / Friction",
          visual_cue: "Visual 1",
          on_screen_text: "Text 1",
          primary_text_hook: "Hook 1",
        },
        {
          angle: "Problem / Friction",
          visual_cue: "Visual 2",
          on_screen_text: "Text 2",
          primary_text_hook: "Hook 2",
        },
        {
          angle: "Material / Craftsmanship",
          visual_cue: "Visual 3",
          on_screen_text: "Text 3",
          primary_text_hook: "Hook 3",
        },
      ],
    };

    const errors = validateBrief(response, targetProduct, catalog);
    expect(errors.some((e) => e.includes("Duplicate angle detected"))).toBe(true);
  });

  it("ignores subset tokens (e.g. Noir) but flags genuine sibling leaks (e.g. Silk Blazer)", () => {
    const response: GeneratedBriefResponse = {
      target_product_title: "Ego Pants (Noir)",
      creative_hooks: [
        {
          angle: "Problem / Friction",
          visual_cue: "Macro shot of Ego Pants in Noir finish",
          on_screen_text: "Deep Noir shade.",
          primary_text_hook: "Pants that maintain their color.",
        },
        {
          angle: "Identity / Status",
          visual_cue: "Pairing perfectly styled with our Silk Blazer for dinner",
          on_screen_text: "Elevated evening fit.",
          primary_text_hook: "Look sharp without trying.",
        },
        {
          angle: "Usability / Transformation",
          visual_cue: "Day to night transition",
          on_screen_text: "From work to weekend.",
          primary_text_hook: "The only pants you need.",
        },
      ],
    };

    const errors = validateBrief(response, targetProduct, catalog);
    expect(errors).toEqual([
      'Hook "Identity / Status" leaked sibling SKU: "Silk Blazer"',
    ]);
  });

  it("flags target product drift", () => {
    const response: GeneratedBriefResponse = {
      target_product_title: "Other Pants",
      creative_hooks: [
        {
          angle: "Problem / Friction",
          visual_cue: "Visual 1",
          on_screen_text: "Text 1",
          primary_text_hook: "Hook 1",
        },
        {
          angle: "Identity / Status",
          visual_cue: "Visual 2",
          on_screen_text: "Text 2",
          primary_text_hook: "Hook 2",
        },
        {
          angle: "Material / Craftsmanship",
          visual_cue: "Visual 3",
          on_screen_text: "Text 3",
          primary_text_hook: "Hook 3",
        },
      ],
    };

    const errors = validateBrief(response, targetProduct, catalog);
    expect(errors.some((e) => e.includes("Product drift"))).toBe(true);
  });

  it("sanitizes leaked tokens with target product title", () => {
    const response: GeneratedBriefResponse = {
      target_product_title: "Other Title",
      creative_hooks: [
        {
          angle: "Identity / Status",
          visual_cue: "Pairing styled with Silk Blazer in studio",
          on_screen_text: "Match with Silk Blazer.",
          primary_text_hook: "Looks incredible with Silk Blazer.",
        },
      ],
    };

    const sanitized = sanitizeLeakedTokens(response, targetProduct, catalog);
    expect(sanitized.target_product_title).toBe("Ego Pants (Noir)");
    expect(sanitized.creative_hooks[0].visual_cue).toBe(
      "Pairing styled with Ego Pants (Noir) in studio"
    );
    expect(sanitized.creative_hooks[0].on_screen_text).toBe(
      "Match with Ego Pants (Noir)."
    );
    expect(sanitized.creative_hooks[0].primary_text_hook).toBe(
      "Looks incredible with Ego Pants (Noir)."
    );
  });
});
