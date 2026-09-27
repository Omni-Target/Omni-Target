import { describe, expect, it } from "vitest";
import { canonicalRegenerationProduct } from "./regeneration-product";

const saved = {
  product_name: "Ego Pants (Noir)",
  product_description: "Wide-leg linen pants\nwith cowrie details.",
  campaign_goal: "Drive Website Sales",
  product_price: "₦14,239.00",
};

describe("canonicalRegenerationProduct", () => {
  it("uses exact saved values after tolerating cosmetic formatting differences", () => {
    expect(canonicalRegenerationProduct(saved, {
      productName: " ego pants (noir) ",
      productDescription: "Wide-leg linen pants with cowrie details.",
      campaignGoal: "Drive Website Sales",
      productPrice: "14239",
    })).toEqual({
      productName: saved.product_name,
      productDescription: saved.product_description,
      campaignGoal: saved.campaign_goal,
      productPrice: saved.product_price,
    });
  });

  it("rejects a changed product before generation", () => {
    expect(canonicalRegenerationProduct(saved, {
      productName: saved.product_name,
      productDescription: "Wide-leg linen pants",
    })).toBeNull();
    expect(canonicalRegenerationProduct(saved, { productPrice: "₦15,000" })).toBeNull();
  });
});
