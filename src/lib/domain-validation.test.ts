import { describe, it, expect } from "vitest";
import { validateShopifyInput } from "./domain-validation";

describe("validateShopifyInput", () => {
  it("rejects plain words without a domain or TLD like 'hello'", () => {
    const result = validateShopifyInput("hello");
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Please enter a valid domain (e.g., yourstore.com or store.myshopify.com).");
  });

  it("rejects empty or whitespace-only input", () => {
    const result = validateShopifyInput("   ");
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Please enter your store website.");
  });

  it("rejects invalid characters or spaces", () => {
    const result = validateShopifyInput("hello world.com");
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Please enter a valid domain (e.g., yourstore.com or store.myshopify.com).");
  });

  it("accepts valid .myshopify.com domains", () => {
    const result = validateShopifyInput("my-store.myshopify.com");
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe("my-store.myshopify.com");
    expect(result.isMyshopify).toBe(true);
  });

  it("accepts valid .myshopify.com domains with protocol and trailing slash", () => {
    const result = validateShopifyInput("https://cool-brand.myshopify.com/");
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe("cool-brand.myshopify.com");
    expect(result.isMyshopify).toBe(true);
  });

  it("rejects bare '.myshopify.com'", () => {
    const result = validateShopifyInput(".myshopify.com");
    expect(result.isValid).toBe(false);
    expect(result.isMyshopify).toBe(true);
  });

  it("accepts standard custom domains", () => {
    const result = validateShopifyInput("allbirds.com");
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe("allbirds.com");
    expect(result.isCustomDomain).toBe(true);
  });

  it("accepts custom domains with subdomains and international TLDs", () => {
    const result = validateShopifyInput("https://shop.gymshark.co.uk/collections/all");
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe("shop.gymshark.co.uk");
    expect(result.isCustomDomain).toBe(true);
  });

  it("strips www and capital letters", () => {
    const result = validateShopifyInput("https://WWW.YourBrand.COM");
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe("yourbrand.com");
  });
});
