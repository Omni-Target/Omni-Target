import { describe, expect, it } from "vitest";
import { SHOPIFY_CREDIT_PLANS, isCreditableCharge, planForShopifyCharge } from "./shopify-billing-plans";

const PROD = { NODE_ENV: "production" };

describe("isCreditableCharge (SEC-12)", () => {
  it("credits active, non-test charges in production", () => {
    expect(isCreditableCharge({ status: "ACTIVE", test: false }, PROD)).toBe(true);
  });

  it("never credits Shopify test charges in production", () => {
    expect(isCreditableCharge({ status: "ACTIVE", test: true }, PROD)).toBe(false);
  });

  it("allows test charges only where test billing is explicitly enabled (staging) or outside production", () => {
    expect(isCreditableCharge({ status: "ACTIVE", test: true }, { NODE_ENV: "production", SHOPIFY_TEST_BILLING: "true" })).toBe(true);
    expect(isCreditableCharge({ status: "ACTIVE", test: true }, { NODE_ENV: "development" })).toBe(true);
  });

  it("never credits charges that are not ACTIVE", () => {
    for (const status of ["PENDING", "DECLINED", "EXPIRED", "CANCELLED", "FROZEN", undefined]) {
      expect(isCreditableCharge({ status, test: false }, PROD)).toBe(false);
    }
  });
});

describe("planForShopifyCharge", () => {
  it("matches the app's own one-time charges exactly (dash/case/spacing tolerant)", () => {
    expect(planForShopifyCharge("Starter Pack – 3 Credits", "one_time")?.credits).toBe(3);
    expect(planForShopifyCharge("growth pack - 10 credits", "one_time")?.credits).toBe(10);
    expect(planForShopifyCharge(SHOPIFY_CREDIT_PLANS.scale.chargeName, "one_time")?.credits).toBe(30);
  });

  it("refuses one-time charges that only resemble a plan name", () => {
    expect(planForShopifyCharge("Scale Pack – 30 Credits BONUS", "one_time")).toBeNull();
    expect(planForShopifyCharge("Upscale promo", "one_time")).toBeNull();
    expect(planForShopifyCharge("", "one_time")).toBeNull();
  });

  it("matches managed-pricing subscriptions by a single whole-word plan keyword", () => {
    expect(planForShopifyCharge("Starter", "subscription")?.key).toBe("starter");
    expect(planForShopifyCharge("Growth Pack", "subscription")?.key).toBe("growth");
  });

  it("refuses ambiguous or partial-word subscription names (old substring matching credited 'Upscale' as Scale)", () => {
    expect(planForShopifyCharge("Upscale", "subscription")).toBeNull();
    expect(planForShopifyCharge("Starter + Growth bundle", "subscription")).toBeNull();
  });
});
