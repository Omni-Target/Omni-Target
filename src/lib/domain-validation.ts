/**
 * Validation and normalization utility for store domains.
 * Supports:
 * - Direct myshopify domains (e.g., store.myshopify.com)
 * - Custom domains (e.g., yourstore.com, shop.brand.co)
 * - URLs with protocol / path (e.g., https://yourstore.com/collections)
 *
 * Explicitly rejects handles without a domain/TLD (e.g. "hello", "test").
 */

export interface DomainValidationResult {
  isValid: boolean;
  normalized: string;
  isMyshopify: boolean;
  isCustomDomain: boolean;
  error?: string;
}

const DOMAIN_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
const MYSHOPIFY_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/i;

export function validateShopifyInput(input: string): DomainValidationResult {
  if (!input || typeof input !== "string") {
    return {
      isValid: false,
      normalized: "",
      isMyshopify: false,
      isCustomDomain: false,
      error: "Please enter your store website.",
    };
  }

  // Clean the input: trim, remove protocol, remove www., extract hostname before slashes or ports
  let cleaned = input.trim().toLowerCase();
  cleaned = cleaned.replace(/^https?:\/\//i, "");
  cleaned = cleaned.replace(/^www\./i, "");
  cleaned = cleaned.split("/")[0]; // remove path
  cleaned = cleaned.split("?")[0]; // remove query
  cleaned = cleaned.split(":")[0]; // remove port

  if (!cleaned) {
    return {
      isValid: false,
      normalized: "",
      isMyshopify: false,
      isCustomDomain: false,
      error: "Please enter your store website.",
    };
  }

  // Check if it contains spaces or invalid characters
  if (/\s/.test(cleaned) || /[^a-zA-Z0-9.-]/.test(cleaned)) {
    return {
      isValid: false,
      normalized: cleaned,
      isMyshopify: false,
      isCustomDomain: false,
      error: "Please enter a valid domain (e.g., yourstore.com or store.myshopify.com).",
    };
  }

  // Case 1: .myshopify.com domain
  if (cleaned.endsWith(".myshopify.com")) {
    if (cleaned === ".myshopify.com" || !MYSHOPIFY_REGEX.test(cleaned)) {
      return {
        isValid: false,
        normalized: cleaned,
        isMyshopify: true,
        isCustomDomain: false,
        error: "Please enter a valid Shopify store name before .myshopify.com.",
      };
    }
    return {
      isValid: true,
      normalized: cleaned,
      isMyshopify: true,
      isCustomDomain: false,
    };
  }

  // Case 2: Reject strings without a dot (e.g., "hello", "test", "mybrand")
  if (!cleaned.includes(".")) {
    return {
      isValid: false,
      normalized: cleaned,
      isMyshopify: false,
      isCustomDomain: false,
      error: "Please enter a valid domain (e.g., yourstore.com or store.myshopify.com).",
    };
  }

  // Case 3: Custom domain check (must have a valid domain structure and valid TLD)
  if (!DOMAIN_REGEX.test(cleaned)) {
    return {
      isValid: false,
      normalized: cleaned,
      isMyshopify: false,
      isCustomDomain: false,
      error: "Please enter a valid domain (e.g., yourstore.com or store.myshopify.com).",
    };
  }

  return {
    isValid: true,
    normalized: cleaned,
    isMyshopify: false,
    isCustomDomain: true,
  };
}
