import { describe, expect, it } from "vitest";
import {
  buildMetaInterestSearchSeeds,
  resolveVerifiedMetaInterests,
  type MetaAdInterestRaw,
} from "./meta-interest-resolver";

describe("meta-interest-resolver", () => {
  it("translates multi-word AI editorial phrases into canonical Meta search seeds", () => {
    const seeds = buildMetaInterestSearchSeeds({
      candidateInterests: [
        "Online Shopping",
        "Women's Fashion",
        "Contemporary Fashion Design",
        "Going Out Outfits",
        "Boutique Shopping",
      ],
      productTitle: "Jindu Bubble Short | Wild Berry",
      productType: "Shorts",
      gender: "Women",
      productPrice: 85000,
      storeAov: 95000,
    });

    expect(seeds).toContain("Online shopping");
    expect(seeds).toContain("Shorts");
    expect(seeds).toContain("Women's clothing");
    expect(seeds).toContain("Designer clothing");
    expect(seeds).toContain("Boutiques");
  });

  it("verifies interests against Meta adinterest response, rejecting bands, wrong gender, and downmarket tags", async () => {
    const mockCatalog: Record<string, MetaAdInterestRaw[]> = {
      "online shopping": [
        {
          id: "1",
          name: "Online shopping (retail)",
          topic: "Shopping and fashion",
          audience_size_lower_bound: 800_000_000,
        },
      ],
      skirt: [
        {
          id: "2",
          name: "Modern Skirts",
          topic: "News and entertainment",
          disambiguation_category: "Musician/band",
          audience_size_lower_bound: 900_000,
        },
        {
          id: "3",
          name: "Skirt (clothing)",
          topic: "Shopping and fashion",
          audience_size_lower_bound: 120_000_000,
        },
      ],
      "women's clothing": [
        {
          id: "4",
          name: "men's clothing (clothing)",
          topic: "Shopping and fashion",
          audience_size_lower_bound: 90_000_000,
        },
        {
          id: "5",
          name: "Women's clothing (clothing)",
          topic: "Shopping and fashion",
          audience_size_lower_bound: 450_000_000,
        },
      ],
      "luxury goods": [
        {
          id: "6",
          name: "Luxury goods (retail)",
          topic: "Shopping and fashion",
          audience_size_lower_bound: 500_000_000,
        },
      ],
      boutiques: [
        {
          id: "7",
          name: "Boutiques (retailers)",
          topic: "Shopping and fashion",
          audience_size_lower_bound: 95_000_000,
        },
      ],
      "fast fashion": [
        {
          id: "8",
          name: "Fast fashion (clothing)",
          topic: "Shopping and fashion",
          audience_size_lower_bound: 50_000_000,
        },
      ],
    };

    const mockFetch: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const q = (url.searchParams.get("q") || "").toLowerCase();
      return new Response(
        JSON.stringify({ data: mockCatalog[q] || [] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const resolved = await resolveVerifiedMetaInterests({
      candidateInterests: [
        "Online Shopping",
        "Women's Fashion",
        "Fast fashion",
        "Boutique Shopping",
      ],
      productTitle: "Ciao Bella Skirt | Mocha",
      productType: "Skirt",
      gender: "Women",
      productPrice: 95000,
      storeAov: 95000,
      accessToken: "mock-token",
      fetchImpl: mockFetch,
    });

    expect(resolved).toEqual([
      "Online shopping",
      "Skirt",
      "Women's clothing",
      "Boutiques",
      "Luxury goods",
    ]);
    expect(resolved).not.toContain("Modern Skirts");
    expect(resolved).not.toContain("Men's clothing");
    expect(resolved).not.toContain("Fast fashion");
  });
});
