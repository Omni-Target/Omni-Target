import { describe, it, expect } from "vitest";
import {
  campaignFormReducer,
  initialCampaignForm,
} from "@/lib/campaigns/form-reducer";

describe("campaignFormReducer", () => {
  it("merges a partial update without touching other fields", () => {
    const next = campaignFormReducer(initialCampaignForm, {
      type: "merge",
      values: { brandName: "Acme", isNewLaunch: true },
    });
    expect(next.brandName).toBe("Acme");
    expect(next.isNewLaunch).toBe(true);
    expect(next.productName).toBe(""); // untouched
    expect(next.goal).toBe("Drive Website Sales"); // untouched default
  });

  it("reset returns every field to its initial value", () => {
    const dirty = campaignFormReducer(initialCampaignForm, {
      type: "merge",
      values: {
        brandName: "Acme",
        productName: "Tee",
        description: "x",
        productPrice: "20",
        productVariants: "S,M",
        goal: "Grow Brand Awareness",
        tone: "Bold & Direct",
        isNewLaunch: true,
        autoFilledFromStore: true,
      },
    });
    expect(campaignFormReducer(dirty, { type: "reset" })).toEqual(
      initialCampaignForm,
    );
  });

  it("reset clears the fields the old handlers used to leave stale", () => {
    // productPrice / productVariants / isNewLaunch were never reset before the
    // reducer; this guards against that bug class returning.
    const dirty = campaignFormReducer(initialCampaignForm, {
      type: "merge",
      values: { productPrice: "99", productVariants: "S,M,L", isNewLaunch: true },
    });
    const reset = campaignFormReducer(dirty, { type: "reset" });
    expect(reset.productPrice).toBe("");
    expect(reset.productVariants).toBe("");
    expect(reset.isNewLaunch).toBe(false);
  });
});
