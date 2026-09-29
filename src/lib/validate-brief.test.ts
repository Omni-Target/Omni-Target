import { describe, it, expect } from "vitest";
import {
  validateBrief,
  sanitizeLeakedTokens,
  finalizeCreativeHooks,
  buildVerifiedFallbackHooks,
  getForbiddenSiblingProducts,
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

  it("ignores shared camera direction while detecting repeated customer claims", () => {
    const response: GeneratedBriefResponse = {
      target_product_title: targetProduct.title,
      creative_hooks: [
        {
          angle: "Daily utility",
          visual_cue: "Macro close-up capturing storefront reflections",
          on_screen_text: "Comfort through the commute.",
          primary_text_hook: "Freedom on busy mornings.",
        },
        {
          angle: "Evening style",
          visual_cue: "Macro close-up capturing storefront reflections",
          on_screen_text: "A polished evening choice.",
          primary_text_hook: "Confidence after sunset.",
        },
        {
          angle: "Quiet ritual",
          visual_cue: "Macro close-up capturing storefront reflections",
          on_screen_text: "A softer daily ritual.",
          primary_text_hook: "Calm in every transition.",
        },
      ],
    };
    expect(validateBrief(response, targetProduct, catalog)).toEqual([]);

    response.creative_hooks[1].on_screen_text = "Freedom through the commute.";
    response.creative_hooks[1].primary_text_hook = "Confidence on busy mornings.";
    expect(validateBrief(response, targetProduct, catalog)).toContainEqual(
      expect.stringContaining("share overlapping claims"),
    );
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

  it("permits harmless title variants like plurals and parenthetical descriptions without drift errors", () => {
    const baseResponse: GeneratedBriefResponse = {
      target_product_title: "Ego Pants", // Omits "(Noir)"
      creative_hooks: [
        {
          angle: "Problem / Friction",
          visual_cue: "Visual 1",
          on_screen_text: "Text 1.",
          primary_text_hook: "Hook 1.",
        },
        {
          angle: "Identity / Status",
          visual_cue: "Visual 2",
          on_screen_text: "Text 2.",
          primary_text_hook: "Hook 2.",
        },
        {
          angle: "Material / Craftsmanship",
          visual_cue: "Visual 3",
          on_screen_text: "Text 3.",
          primary_text_hook: "Hook 3.",
        },
      ],
    };

    const errors = validateBrief(baseResponse, targetProduct, catalog);
    expect(errors.some((e) => e.includes("Product drift"))).toBe(false);

    // Test pluralization e.g. "Jindu Bubble Short" vs "Jindu Bubble Shorts"
    const shortProduct: TargetProductContext = {
      id: "prod-short",
      title: "Jindu Bubble Short",
      description: "Linen relaxed short with deep pockets.",
    };
    const pluralResponse: GeneratedBriefResponse = {
      target_product_title: "Jindu Bubble Shorts",
      creative_hooks: baseResponse.creative_hooks,
    };
    const pluralErrors = validateBrief(pluralResponse, shortProduct, catalog);
    expect(pluralErrors.some((e) => e.includes("Product drift"))).toBe(false);
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

  it("repairs punctuated sibling titles using the validator's matching rules", () => {
    const response: GeneratedBriefResponse = {
      target_product_title: targetProduct.title,
      creative_hooks: [{
        angle: "Identity / Status",
        visual_cue: "Style the Silk-Blazer beside the pants",
        on_screen_text: "Silk-Blazer pairing.",
        primary_text_hook: "A look with Silk-Blazer.",
      }],
    };
    const sanitized = sanitizeLeakedTokens(response, targetProduct, catalog);
    expect(JSON.stringify(sanitized)).not.toMatch(/Silk-Blazer/i);
  });

  it("falls back instead of turning a sibling pairing into a self-pairing ad", () => {
    const product = { ...targetProduct, description: "Cotton pants with a clean silhouette." };
    const hooks = buildVerifiedFallbackHooks(product, catalog)!;
    hooks[0].primary_text_hook = "Pair with the Silk Blazer.";
    expect(finalizeCreativeHooks({ target_product_title: product.title, creative_hooks: hooks }, product, catalog)).toBeNull();
  });

  it("rejects a partial or unsupported final hook set", () => {
    const product = { ...targetProduct, description: "Linen pants with cowrie details." };
    const partial: GeneratedBriefResponse = {
      target_product_title: product.title,
      creative_hooks: [{
        angle: "Material / Craftsmanship",
        visual_cue: "Close-up of the pants",
        on_screen_text: "Pure silk fabric.",
        primary_text_hook: "Discover pure silk in Ego Pants.",
      }],
    };
    expect(finalizeCreativeHooks(partial, product, catalog)).toBeNull();
    const complete = buildVerifiedFallbackHooks(product, catalog)!;
    complete[0].primary_text_hook = "Discover pure silk in Ego Pants.";
    expect(finalizeCreativeHooks({ target_product_title: product.title, creative_hooks: complete }, product, catalog)).toBeNull();
    expect(finalizeCreativeHooks(
      { target_product_title: 7, creative_hooks: complete } as unknown as GeneratedBriefResponse,
      product,
      catalog,
    )).toBeNull();
  });

  it("builds and validates three hooks from a verified product detail", () => {
    const product = {
      ...targetProduct,
      description: "Wide-legged linen pants with hand-beaded cowrie details.",
    };
    const hooks = buildVerifiedFallbackHooks(product, catalog);
    expect(hooks).toHaveLength(3);
    expect(hooks?.[2].primary_text_hook).toContain("cowrie details");
    expect(validateBrief({ target_product_title: product.title, creative_hooks: hooks || [] }, product, catalog)).toEqual([]);
  });

  it("does not invent fallback product features when the description has none", () => {
    expect(buildVerifiedFallbackHooks({ ...targetProduct, description: "A lovely piece." }, catalog)).toBeNull();
    expect(buildVerifiedFallbackHooks({ ...targetProduct, description: "Made without leather." }, catalog)).toBeNull();
    expect(buildVerifiedFallbackHooks(
      { ...targetProduct, description: "Pants to pair with the Silk Blazer." },
      catalog,
    )).toBeNull();
  });

  it("does not treat a sibling's title as evidence for the target product", () => {
    const product = { ...targetProduct, description: "Cotton pants. Pair with the Silk Blazer." };
    const hooks = buildVerifiedFallbackHooks(product, catalog)!;
    expect(hooks[2].primary_text_hook).toContain("cotton fabric");
    const response: GeneratedBriefResponse = {
      target_product_title: product.title,
      creative_hooks: hooks.map((hook) => ({ ...hook })),
    };
    response.creative_hooks[0].primary_text_hook = "Discover pure silk in Ego Pants.";
    expect(finalizeCreativeHooks(response, product, catalog)).toBeNull();
  });

  describe("factual claim validation", () => {
    it("catches an unsupported material claim", () => {
      const response: GeneratedBriefResponse = {
        target_product_title: "Ego Pants (Noir)",
        creative_hooks: [
          {
            angle: "Material / Craftsmanship",
            visual_cue: "Macro shot",
            on_screen_text: "Made with genuine leather.",
            primary_text_hook: "Best genuine leather pants.",
          },
          {
            angle: "Identity / Status",
            visual_cue: "Visual 2",
            on_screen_text: "Text 2",
            primary_text_hook: "Hook 2",
          },
          {
            angle: "Problem / Friction",
            visual_cue: "Visual 3",
            on_screen_text: "Text 3",
            primary_text_hook: "Hook 3",
          },
        ],
      };

      const product = { ...targetProduct, description: "A great pair of pants made from synthetic materials." };
      const errors = validateBrief(response, product, catalog);
      expect(errors.some((e) => e.includes("Unsupported factual claim: \"genuine leather\""))).toBe(true);
    });

    it("allows a supported claim", () => {
      const response: GeneratedBriefResponse = {
        target_product_title: "Ego Pants (Noir)",
        creative_hooks: [
          {
            angle: "Material / Craftsmanship",
            visual_cue: "Macro shot",
            on_screen_text: "Made with genuine leather.",
            primary_text_hook: "Best genuine leather pants.",
          },
          {
            angle: "Identity / Status",
            visual_cue: "Visual 2",
            on_screen_text: "Text 2",
            primary_text_hook: "Hook 2",
          },
          {
            angle: "Problem / Friction",
            visual_cue: "Visual 3",
            on_screen_text: "Text 3",
            primary_text_hook: "Hook 3",
          },
        ],
      };

      const product = { ...targetProduct, description: "A great pair of pants made from genuine leather." };
      const errors = validateBrief(response, product, catalog);
      expect(errors.some((e) => e.includes("Unsupported factual claim"))).toBe(false);
    });

    it("catches an unsupported certification claim", () => {
      const response: GeneratedBriefResponse = {
        target_product_title: "Ego Pants (Noir)",
        creative_hooks: [
          {
            angle: "Material / Craftsmanship",
            visual_cue: "Macro shot",
            on_screen_text: "FDA-approved design.",
            primary_text_hook: "The only FDA-approved pants.",
          },
          {
            angle: "Identity / Status",
            visual_cue: "Visual 2",
            on_screen_text: "Text 2",
            primary_text_hook: "Hook 2",
          },
          {
            angle: "Problem / Friction",
            visual_cue: "Visual 3",
            on_screen_text: "Text 3",
            primary_text_hook: "Hook 3",
          },
        ],
      };

      const product = { ...targetProduct, description: "A great pair of pants." };
      const errors = validateBrief(response, product, catalog);
      expect(errors.some((e) => e.includes("Unsupported factual claim: \"FDA-approved\""))).toBe(true);
    });

    it("permits sibling references that are explicitly endorsed in the target product description", () => {
      const productWithSiblingRef: TargetProductContext = {
        id: "prod-1",
        title: "Ego Pants (Noir)",
        tags: ["pants", "bottoms"],
        description: "Wide-legged pure linen pants. Pair with the Ego Dress for an elevated set.",
      };
      const extendedCatalog: CatalogItem[] = [
        ...catalog,
        { id: "prod-5", title: "Ego Dress" },
      ];
      const response: GeneratedBriefResponse = {
        target_product_title: "Ego Pants (Noir)",
        creative_hooks: [
          {
            angle: "Problem / Friction",
            visual_cue: "Visual shot of pants",
            on_screen_text: "Breathable comfort.",
            primary_text_hook: "Stop compromising on fit.",
          },
          {
            angle: "Identity / Status",
            visual_cue: "Pair with the Ego Dress for an elevated complete set",
            on_screen_text: "Pair with the Ego Dress.",
            primary_text_hook: "The effortless set you reach for first.",
          },
          {
            angle: "Material / Craftsmanship",
            visual_cue: "Close-up of fabric",
            on_screen_text: "Pure linen weave.",
            primary_text_hook: "Crafted for hot summer days.",
          },
        ],
      };

      const errors = validateBrief(response, productWithSiblingRef, extendedCatalog);
      expect(errors).toEqual([]);
      expect(getForbiddenSiblingProducts(productWithSiblingRef, extendedCatalog).map((item) => item.title))
        .not.toContain("Ego Dress");
    });

    it("does not flag salient overlap for core product attributes present in the description", () => {
      const productWithAttributes: TargetProductContext = {
        id: "prod-1",
        title: "Ego Pants (Noir)",
        tags: ["pants"],
        description: "100% breathable linen pants featuring hand-beaded cowrie details along the hem.",
      };
      const response: GeneratedBriefResponse = {
        target_product_title: "Ego Pants (Noir)",
        creative_hooks: [
          {
            angle: "Problem / Friction",
            visual_cue: "Macro shot of cowrie hem",
            on_screen_text: "Breathable linen designed with cowrie details.",
            primary_text_hook: "No more hot, restrictive trousers.",
          },
          {
            angle: "Material / Craftsmanship",
            visual_cue: "Close-up of hand-beaded cowrie stitch",
            on_screen_text: "Delicate cowrie accents on airy breathable linen.",
            primary_text_hook: "Artisanal detail at every seam.",
          },
          {
            angle: "Identity / Status",
            visual_cue: "Model in natural setting",
            on_screen_text: "Effortless silhouette.",
            primary_text_hook: "Stand out quietly.",
          },
        ],
      };

      const errors = validateBrief(response, productWithAttributes, catalog);
      expect(errors).toEqual([]);
    });

    it("treats director notes as visual cues, not customer copy", () => {
      const product = { ...targetProduct, description: "Cotton pants for everyday styling." };
      const hooks = buildVerifiedFallbackHooks(product, catalog)!;
      hooks[0].visual_cue = "Director: use a dramatic silk-like light flare!";
      expect(validateBrief({ target_product_title: product.title, creative_hooks: hooks }, product, catalog)).toEqual([]);
    });

    it("normalizes exclamation marks into periods without throwing errors", () => {
      const product: TargetProductContext = {
        id: "prod-1",
        title: "Ego Pants (Noir)",
        tags: ["pants"],
        description: "Clean linen pants.",
      };
      const response: GeneratedBriefResponse = {
        target_product_title: "Ego Pants (Noir)",
        creative_hooks: [
          {
            angle: "Problem / Friction",
            visual_cue: "Visual 1",
            on_screen_text: "Feel the breeze!",
            primary_text_hook: "Never settle for uncomfortable trousers again!",
          },
          {
            angle: "Identity / Status",
            visual_cue: "Visual 2",
            on_screen_text: "Pure silhouette.",
            primary_text_hook: "Everyday luxury.",
          },
          {
            angle: "Material / Craftsmanship",
            visual_cue: "Visual 3",
            on_screen_text: "True craft.",
            primary_text_hook: "Made to last.",
          },
        ],
      };

      const errors = validateBrief(response, product, catalog);
      expect(errors).toEqual([]);
      expect(response.creative_hooks[0].on_screen_text).toBe("Feel the breeze.");
      expect(response.creative_hooks[0].primary_text_hook).toBe("Never settle for uncomfortable trousers again.");
    });
  });
});
