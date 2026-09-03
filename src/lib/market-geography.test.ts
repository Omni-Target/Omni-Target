import { describe, it, expect } from "vitest";
import {
  normalizeCountry,
  isSameCountry,
  getEffectiveStoreCountry,
  isDomesticCity,
  getInternationalBudgetFloor,
  getInternationalStrategies,
  isTier1Market,
} from "./market-geography";

describe("market-geography dynamic utility", () => {
  it("normalizes common country aliases and codes", () => {
    expect(normalizeCountry("NG")).toBe("nigeria");
    expect(normalizeCountry("Nigeria")).toBe("nigeria");
    expect(normalizeCountry("GB")).toBe("unitedkingdom");
    expect(normalizeCountry("UK")).toBe("unitedkingdom");
    expect(normalizeCountry("United Kingdom")).toBe("unitedkingdom");
    expect(normalizeCountry("US")).toBe("unitedstates");
    expect(normalizeCountry("USA")).toBe("unitedstates");
    expect(normalizeCountry("United States")).toBe("unitedstates");
  });

  it("dynamically compares same countries", () => {
    expect(isSameCountry("Nigeria", "NG")).toBe(true);
    expect(isSameCountry("United States", "US")).toBe(true);
    expect(isSameCountry("UK", "United Kingdom")).toBe(true);
    expect(isSameCountry("Nigeria", "US")).toBe(false);
    expect(isSameCountry("United Kingdom", "Nigeria")).toBe(false);
  });

  it("correctly resolves effective store country when registered in US but operating in Nigeria with NGN", () => {
    const topLocations = [
      { city: "Lagos", country: "Nigeria", percentage: 87 },
      { city: "New York", country: "United States", percentage: 8 },
      { city: "London", country: "United Kingdom", percentage: 3 },
    ];
    // Store registered country says "US", but currency is NGN and 87% orders in Nigeria
    const effective = getEffectiveStoreCountry("US", "NGN", topLocations);
    expect(effective).toBe("Nigeria");
  });

  it("correctly classifies domestic vs international cities using order history", () => {
    const topLocations = [
      { city: "Lagos", country: "Nigeria", percentage: 87 },
      { city: "New York", country: "United States", percentage: 8 },
      { city: "London", country: "United Kingdom", percentage: 3 },
      { city: "Hungary", country: "Hungary", percentage: 1 },
      { city: "Netherlands", country: "Netherlands", percentage: 1 },
    ];

    // Domestic check for Lagos -> MUST BE TRUE
    expect(isDomesticCity("Lagos", undefined, "US", "NGN", topLocations)).toBe(true);

    // Domestic check for New York -> MUST BE FALSE
    expect(isDomesticCity("New York", undefined, "US", "NGN", topLocations)).toBe(false);

    // Domestic check for London -> MUST BE FALSE
    expect(isDomesticCity("London", undefined, "US", "NGN", topLocations)).toBe(false);

    // Domestic check for Hungary -> MUST BE FALSE
    expect(isDomesticCity("Hungary", undefined, "US", "NGN", topLocations)).toBe(false);

    // Domestic check for Netherlands -> MUST BE FALSE
    expect(isDomesticCity("Netherlands", undefined, "US", "NGN", topLocations)).toBe(false);
  });

  it("formats international budget floor dynamically", () => {
    expect(getInternationalBudgetFloor("NGN", 1600)).toBe("₦28,800/day ($18/day min)");
    expect(getInternationalBudgetFloor("USD")).toBe("$18/day minimum");
  });

  it("calculates 3 international budget strategies based on Tier-1 CPM floors", () => {
    const strategies = getInternationalStrategies("NGN", 1600);
    expect(strategies).toHaveLength(3);
    expect(strategies[0].label).toBe("Dip Your Toe");
    expect(strategies[0].daily).toBe(28800); // 18 * 1600
    expect(strategies[1].label).toBe("Sweet Spot");
    expect(strategies[1].daily).toBe(40000); // 25 * 1600
    expect(strategies[2].label).toBe("Full Send");
    expect(strategies[2].daily).toBe(64000); // 40 * 1600
  });

  it("identifies Tier-1 markets accurately", () => {
    expect(isTier1Market("United States", "USD")).toBe(true);
    expect(isTier1Market("US", "USD")).toBe(true);
    expect(isTier1Market("United Kingdom", "GBP")).toBe(true);
    expect(isTier1Market("Canada", "CAD")).toBe(true);
    expect(isTier1Market("Nigeria", "NGN")).toBe(false);
    expect(isTier1Market("Ghana", "GHS")).toBe(false);
  });

  it("scales international strategies proportionally for Tier-1 domestic stores", () => {
    // For a US store spending $15/day, sweet spot should match $15/day instead of an inflated $25 floor
    const usStrategies = getInternationalStrategies("USD", undefined, 15);
    expect(usStrategies[0].daily).toBe(9); // 15 * 0.6
    expect(usStrategies[1].daily).toBe(15); // matches domestic daily
    expect(usStrategies[2].daily).toBe(23); // 15 * 1.5

    // For a Nigerian store spending ₦20,000/day, protective floors remain intact
    const ngnStrategies = getInternationalStrategies("NGN", undefined, 20000);
    expect(ngnStrategies[0].daily).toBe(28800);
    expect(ngnStrategies[1].daily).toBe(40000);
    expect(ngnStrategies[2].daily).toBe(64000);
  });
});
