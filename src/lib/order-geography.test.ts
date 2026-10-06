import { describe, expect, it } from "vitest";
import { summarizeOrderCountries } from "./order-geography";

describe("summarizeOrderCountries", () => {
  it("uses real order countries when every city is absent", () => {
    const countries = summarizeOrderCountries([
      { shipping_address: { country: "Nigeria", country_code: "NG" } },
      { shipping_address: { country: "Nigeria", country_code: "NG" } },
      { billing_address: { country_code: "GH" } },
      { billing_address: {} },
    ]);
    expect(countries).toEqual([
      { country: "Nigeria", order_count: 2 },
      { country: "Ghana", order_count: 1 },
    ]);
  });

  it("does not attach the billing country code to a different shipping country", () => {
    expect(summarizeOrderCountries([
      {
        shipping_address: { country: "Nigeria" },
        billing_address: { country: "United States", country_code: "US" },
      },
    ])).toEqual([{ country: "Nigeria", order_count: 1 }]);
  });
});
