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

const consolidateNg = (city: string) => consolidateLocation(city, "NG");

describe("consolidateLocation", () => {
  // ── Lagos neighborhoods ──────────────────────────────────────
  describe("Lagos resolution", () => {
    it("resolves 'Lagos' itself", () => {
      expect(consolidateNg("Lagos")).toBe("Lagos");
      expect(consolidateNg("lagos")).toBe("Lagos");
      expect(consolidateNg("LAGOS")).toBe("Lagos");
    });

    it("resolves Ikate → Lagos (the original bug)", () => {
      expect(consolidateNg("Ikate")).toBe("Lagos");
      expect(consolidateNg("ikate")).toBe("Lagos");
      expect(consolidateNg("Ikate Elegushi")).toBe("Lagos");
    });

    it("resolves Lekki axis neighborhoods → Lagos", () => {
      expect(consolidateNg("Lekki")).toBe("Lagos");
      expect(consolidateNg("Sangotedo")).toBe("Lagos");
      expect(consolidateNg("Agungi")).toBe("Lagos");
      expect(consolidateNg("Oniru")).toBe("Lagos");
      expect(consolidateNg("Jakande")).toBe("Lagos");
      expect(consolidateNg("Ologolo")).toBe("Lagos");
      expect(consolidateNg("Chevron")).toBe("Lagos");
    });

    it("resolves mainland neighborhoods → Lagos", () => {
      expect(consolidateNg("Yaba")).toBe("Lagos");
      expect(consolidateNg("Surulere")).toBe("Lagos");
      expect(consolidateNg("Ikeja")).toBe("Lagos");
      expect(consolidateNg("Gbagada")).toBe("Lagos");
      expect(consolidateNg("Ojo")).toBe("Lagos");
      expect(consolidateNg("Ogba")).toBe("Lagos");
      expect(consolidateNg("Alausa")).toBe("Lagos");
      expect(consolidateNg("Oregun")).toBe("Lagos");
      expect(consolidateNg("Opebi")).toBe("Lagos");
    });

    it("resolves island/waterfront neighborhoods → Lagos", () => {
      expect(consolidateNg("Ikoyi")).toBe("Lagos");
      expect(consolidateNg("Victoria Island")).toBe("Lagos");
      expect(consolidateNg("VI")).toBe("Lagos");
      expect(consolidateNg("Banana Island")).toBe("Lagos");
      expect(consolidateNg("Obalende")).toBe("Lagos");
    });

    it("resolves compound address strings → Lagos", () => {
      expect(consolidateNg("Lekki Phase 1")).toBe("Lagos");
      expect(consolidateNg("Ikeja, Lagos")).toBe("Lagos");
      expect(consolidateNg("Ajah Lagos")).toBe("Lagos");
    });

    it("ensures ALL LAGOS_AREAS entries resolve to Lagos", () => {
      for (const area of LAGOS_AREAS) {
        const result = consolidateNg(area);
        expect(result).toBe("Lagos");
      }
    });
  });

  // ── Abuja neighborhoods ──────────────────────────────────────
  describe("Abuja resolution", () => {
    it("resolves Abuja neighborhoods → Abuja", () => {
      expect(consolidateNg("Maitama")).toBe("Abuja");
      expect(consolidateNg("Wuse")).toBe("Abuja");
      expect(consolidateNg("Garki")).toBe("Abuja");
      expect(consolidateNg("Gwarinpa")).toBe("Abuja");
      expect(consolidateNg("FCT")).toBe("Abuja");
    });

    it("ensures ALL ABUJA_AREAS entries resolve to Abuja", () => {
      for (const area of ABUJA_AREAS) {
        const result = consolidateNg(area);
        expect(result).toBe("Abuja");
      }
    });
  });

  // ── Port Harcourt neighborhoods ──────────────────────────────
  describe("Port Harcourt resolution", () => {
    it("resolves PH neighborhoods → Port Harcourt", () => {
      expect(consolidateNg("Trans Amadi")).toBe("Port Harcourt");
      expect(consolidateNg("Rumuola")).toBe("Port Harcourt");
      expect(consolidateNg("PH")).toBe("Port Harcourt");
      expect(consolidateNg("Port-Harcourt")).toBe("Port Harcourt");
    });

    it("ensures ALL PH_AREAS entries resolve to Port Harcourt", () => {
      for (const area of PH_AREAS) {
        const result = consolidateNg(area);
        expect(result).toBe("Port Harcourt");
      }
    });
  });

  // ── Other Nigerian cities ────────────────────────────────────
  describe("other Nigerian city resolution", () => {
    it("resolves Benin City", () => {
      expect(consolidateNg("Benin City")).toBe("Benin City");
      expect(consolidateNg("Oredo")).toBe("Benin City");
    });

    it("resolves Ibadan", () => {
      expect(consolidateNg("Ibadan")).toBe("Ibadan");
      expect(consolidateNg("Bodija")).toBe("Ibadan");
    });

    it("resolves other major cities", () => {
      expect(consolidateNg("Enugu")).toBe("Enugu");
      expect(consolidateNg("Kaduna")).toBe("Kaduna");
      expect(consolidateNg("Kano")).toBe("Kano");
      expect(consolidateNg("Warri")).toBe("Warri");
      expect(consolidateNg("Calabar")).toBe("Calabar");
      expect(consolidateNg("Abeokuta")).toBe("Abeokuta");
    });
  });

  // ── International ────────────────────────────────────────────
  describe("international resolution", () => {
    it("resolves London", () => {
      expect(consolidateLocation("London", "GB")).toBe("London");
      expect(consolidateLocation("Greater London", "GB")).toBe("London");
    });
  });

  // ── The core fix: unrecognized cities return null ────────────
  describe("null return for unrecognized cities", () => {
    it("returns null for empty/falsy input", () => {
      expect(consolidateNg("")).toBeNull();
      expect(consolidateNg(null as unknown as string)).toBeNull();
      expect(consolidateNg(undefined as unknown as string)).toBeNull();
    });

    it("returns null for unrecognized neighborhoods (so AI tier resolves them)", () => {
      // These are real neighborhoods that are NOT in the static lists
      // and should flow to the AI tier for dynamic resolution
      expect(consolidateNg("Shoreditch")).toBeNull();
      expect(consolidateNg("Camden")).toBeNull();
      expect(consolidateNg("Brooklyn")).toBeNull();
      expect(consolidateNg("Queens")).toBeNull();
      expect(consolidateNg("Bronx")).toBeNull();
      expect(consolidateNg("East Legon")).toBeNull();
      expect(consolidateNg("Cantonments")).toBeNull();
    });

    it("returns null for legitimate foreign cities (AI returns them as-is)", () => {
      expect(consolidateNg("Manchester")).toBeNull();
      expect(consolidateNg("Paris")).toBeNull();
      expect(consolidateNg("Houston")).toBeNull();
      expect(consolidateNg("Toronto")).toBeNull();
    });
  });

  // ── Dirty input handling ─────────────────────────────────────
  describe("dirty input handling", () => {
    it("handles punctuation and extra whitespace", () => {
      expect(consolidateNg("  Ikate  ")).toBe("Lagos");
      expect(consolidateNg("Lekki, Lagos.")).toBe("Lagos");
      expect(consolidateNg("Maitama - Abuja")).toBe("Abuja");
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

describe("Nigerian rules never apply to other countries (GEO-01)", () => {
  it.each([
    ["Riverside", "US"],
    ["San Jose", "United States"],
    ["Warrington", "GB"],
    ["Allen", "US"],
    ["APO", "US"],
    ["Maryland", "US"],
    ["Lagos", "PT"],
    ["Benin", "BJ"],
    ["Rivers", "CA"],
  ])("%s in %s is not rewritten to a Nigerian metro", (city, country) => {
    expect(consolidateLocation(city, country)).toBeNull();
  });

  it("does not assume Nigeria when the order has no country", () => {
    expect(consolidateLocation("Lagos", undefined)).toBeNull();
    expect(consolidateLocation("Ikeja", "")).toBeNull();
  });

  it("matches whole words even within Nigeria", () => {
    expect(consolidateLocation("Riverside Estate", "NG")).toBeNull();
    expect(consolidateLocation("Rivers State", "NG")).toBe("Port Harcourt");
    expect(consolidateLocation("Jos North", "Nigeria")).toBe("Jos");
  });

  it("applies the London rule only to UK orders", () => {
    expect(consolidateLocation("London", "United Kingdom")).toBe("London");
    expect(consolidateLocation("London", "US")).toBeNull();
  });
});
