import { describe, it, expect } from "vitest";
import {
  resolveStoreDomain,
  validateCampaignForm,
} from "@/lib/campaigns/derive";
import type { StoreInsights } from "@/components/campaigns/types";

describe("resolveStoreDomain", () => {
  it("prefers the connected store domain and strips scheme + www.", () => {
    const insights: StoreInsights = {
      store: { domain: "https://www.shop.example.com" },
    };
    expect(resolveStoreDomain(insights, "ignored.com")).toBe("shop.example.com");
  });

  it("prepends https:// when the store domain has no scheme", () => {
    const insights: StoreInsights = { store: { domain: "shop.example.com" } };
    expect(resolveStoreDomain(insights, "")).toBe("shop.example.com");
  });

  it("falls back to the Clerk store URL when there is no connected domain", () => {
    expect(resolveStoreDomain(null, "www.mystore.com")).toBe("mystore.com");
    expect(resolveStoreDomain({ store: {} }, "https://mystore.com")).toBe(
      "mystore.com",
    );
  });

  it("returns the placeholder when nothing is available", () => {
    expect(resolveStoreDomain(null, "")).toBe("yourstore.com");
  });
});

describe("validateCampaignForm", () => {
  it("returns no errors when all required fields are present", () => {
    expect(
      validateCampaignForm({
        brandName: "Acme",
        productName: "Tee",
        description: "Nice",
      }),
    ).toEqual([]);
  });

  it("flags each missing or whitespace-only field", () => {
    expect(
      validateCampaignForm({
        brandName: "  ",
        productName: "",
        description: "x",
      }),
    ).toEqual(["Brand name is required", "Product name is required"]);
  });

  it("returns all three errors when everything is empty", () => {
    expect(
      validateCampaignForm({ brandName: "", productName: "", description: "" }),
    ).toHaveLength(3);
  });
});
