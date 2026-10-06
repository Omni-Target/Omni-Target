import { describe, expect, it, vi } from "vitest";

// Mock external dependencies to prevent initialization errors in tests
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic { messages = { create: vi.fn() }; }
  return { default: MockAnthropic };
});
vi.mock("@/lib/db", () => ({
  logApiUsage: vi.fn(),
}));

import { consolidateLocation, formatCityName, LAGOS_AREAS, ABUJA_AREAS, PH_AREAS } from "./locations";

describe("consolidateLocation", () => {
  // ── Lagos neighborhoods ──────────────────────────────────────
  describe("Lagos resolution", () => {
    it("resolves 'Lagos' itself", () => {
      expect(consolidateLocation("Lagos")).toBe("Lagos");
      expect(consolidateLocation("lagos")).toBe("Lagos");
      expect(consolidateLocation("LAGOS")).toBe("Lagos");
    });

    it("resolves Ikate → Lagos (the original bug)", () => {
      expect(consolidateLocation("Ikate")).toBe("Lagos");
      expect(consolidateLocation("ikate")).toBe("Lagos");
      expect(consolidateLocation("Ikate Elegushi")).toBe("Lagos");
    });

    it("resolves Lekki axis neighborhoods → Lagos", () => {
      expect(consolidateLocation("Lekki")).toBe("Lagos");
      expect(consolidateLocation("Sangotedo")).toBe("Lagos");
      expect(consolidateLocation("Agungi")).toBe("Lagos");
      expect(consolidateLocation("Oniru")).toBe("Lagos");
      expect(consolidateLocation("Jakande")).toBe("Lagos");
      expect(consolidateLocation("Ologolo")).toBe("Lagos");
      expect(consolidateLocation("Chevron")).toBe("Lagos");
    });

    it("resolves mainland neighborhoods → Lagos", () => {
      expect(consolidateLocation("Yaba")).toBe("Lagos");
      expect(consolidateLocation("Surulere")).toBe("Lagos");
      expect(consolidateLocation("Ikeja")).toBe("Lagos");
      expect(consolidateLocation("Gbagada")).toBe("Lagos");
      expect(consolidateLocation("Ojo")).toBe("Lagos");
      expect(consolidateLocation("Ogba")).toBe("Lagos");
      expect(consolidateLocation("Alausa")).toBe("Lagos");
      expect(consolidateLocation("Oregun")).toBe("Lagos");
      expect(consolidateLocation("Opebi")).toBe("Lagos");
    });

    it("resolves island/waterfront neighborhoods → Lagos", () => {
      expect(consolidateLocation("Ikoyi")).toBe("Lagos");
      expect(consolidateLocation("Victoria Island")).toBe("Lagos");
      expect(consolidateLocation("VI")).toBe("Lagos");
      expect(consolidateLocation("Banana Island")).toBe("Lagos");
      expect(consolidateLocation("Obalende")).toBe("Lagos");
    });

    it("resolves compound address strings → Lagos", () => {
      expect(consolidateLocation("Lekki Phase 1")).toBe("Lagos");
      expect(consolidateLocation("Ikeja, Lagos")).toBe("Lagos");
      expect(consolidateLocation("Ajah Lagos")).toBe("Lagos");
    });

    it("ensures ALL LAGOS_AREAS entries resolve to Lagos", () => {
      for (const area of LAGOS_AREAS) {
        const result = consolidateLocation(area);
        expect(result).toBe("Lagos");
      }
    });
  });

  // ── Abuja neighborhoods ──────────────────────────────────────
  describe("Abuja resolution", () => {
    it("resolves Abuja neighborhoods → Abuja", () => {
      expect(consolidateLocation("Maitama")).toBe("Abuja");
      expect(consolidateLocation("Wuse")).toBe("Abuja");
      expect(consolidateLocation("Garki")).toBe("Abuja");
      expect(consolidateLocation("Gwarinpa")).toBe("Abuja");
      expect(consolidateLocation("FCT")).toBe("Abuja");
    });

    it("ensures ALL ABUJA_AREAS entries resolve to Abuja", () => {
      for (const area of ABUJA_AREAS) {
        const result = consolidateLocation(area);
        expect(result).toBe("Abuja");
      }
    });
  });

  // ── Port Harcourt neighborhoods ──────────────────────────────
  describe("Port Harcourt resolution", () => {
    it("resolves PH neighborhoods → Port Harcourt", () => {
      expect(consolidateLocation("Trans Amadi")).toBe("Port Harcourt");
      expect(consolidateLocation("Rumuola")).toBe("Port Harcourt");
      expect(consolidateLocation("PH")).toBe("Port Harcourt");
      expect(consolidateLocation("Port-Harcourt")).toBe("Port Harcourt");
    });

    it("ensures ALL PH_AREAS entries resolve to Port Harcourt", () => {
      for (const area of PH_AREAS) {
        const result = consolidateLocation(area);
        expect(result).toBe("Port Harcourt");
      }
    });
  });

  // ── Other Nigerian cities ────────────────────────────────────
  describe("other Nigerian city resolution", () => {
    it("resolves Benin City", () => {
      expect(consolidateLocation("Benin City")).toBe("Benin City");
      expect(consolidateLocation("Oredo")).toBe("Benin City");
    });

    it("resolves Ibadan", () => {
      expect(consolidateLocation("Ibadan")).toBe("Ibadan");
      expect(consolidateLocation("Bodija")).toBe("Ibadan");
    });

    it("resolves other major cities", () => {
      expect(consolidateLocation("Enugu")).toBe("Enugu");
      expect(consolidateLocation("Kaduna")).toBe("Kaduna");
      expect(consolidateLocation("Kano")).toBe("Kano");
      expect(consolidateLocation("Warri")).toBe("Warri");
      expect(consolidateLocation("Calabar")).toBe("Calabar");
      expect(consolidateLocation("Abeokuta")).toBe("Abeokuta");
    });
  });

  // ── International ────────────────────────────────────────────
  describe("international resolution", () => {
    it("resolves London", () => {
      expect(consolidateLocation("London")).toBe("London");
      expect(consolidateLocation("Greater London")).toBe("London");
    });
  });

  // ── The core fix: unrecognized cities return null ────────────
  describe("null return for unrecognized cities", () => {
    it("returns null for empty/falsy input", () => {
      expect(consolidateLocation("")).toBeNull();
      expect(consolidateLocation(null as unknown as string)).toBeNull();
      expect(consolidateLocation(undefined as unknown as string)).toBeNull();
    });

    it("returns null for unrecognized neighborhoods (so AI tier resolves them)", () => {
      // These are real neighborhoods that are NOT in the static lists
      // and should flow to the AI tier for dynamic resolution
      expect(consolidateLocation("Shoreditch")).toBeNull();
      expect(consolidateLocation("Camden")).toBeNull();
      expect(consolidateLocation("Brooklyn")).toBeNull();
      expect(consolidateLocation("Queens")).toBeNull();
      expect(consolidateLocation("Bronx")).toBeNull();
      expect(consolidateLocation("East Legon")).toBeNull();
      expect(consolidateLocation("Cantonments")).toBeNull();
    });

    it("returns null for legitimate foreign cities (AI returns them as-is)", () => {
      expect(consolidateLocation("Manchester")).toBeNull();
      expect(consolidateLocation("Paris")).toBeNull();
      expect(consolidateLocation("Houston")).toBeNull();
      expect(consolidateLocation("Toronto")).toBeNull();
    });
  });

  // ── Dirty input handling ─────────────────────────────────────
  describe("dirty input handling", () => {
    it("handles punctuation and extra whitespace", () => {
      expect(consolidateLocation("  Ikate  ")).toBe("Lagos");
      expect(consolidateLocation("Lekki, Lagos.")).toBe("Lagos");
      expect(consolidateLocation("Maitama - Abuja")).toBe("Abuja");
    });
  });
});

describe("formatCityName", () => {
  it("title-cases simple city names", () => {
    expect(formatCityName("manchester")).toBe("Manchester");
    expect(formatCityName("NEW YORK")).toBe("New York");
    expect(formatCityName("port harcourt")).toBe("Port Harcourt");
  });

  it("cleans punctuation and extra whitespace", () => {
    expect(formatCityName("  san  francisco  ")).toBe("San Francisco");
    expect(formatCityName("east-legon")).toBe("East Legon");
  });

  it("returns Unknown for empty input", () => {
    expect(formatCityName("")).toBe("Unknown");
  });
});
