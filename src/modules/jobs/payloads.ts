import { z } from "zod";
import { isValidShopDomain } from "@/lib/shopify-oauth";

/**
 * Payloads of the Trigger.dev tasks (Phase 2). Validated by the task before it
 * runs, and typed for the code that triggers it. Payloads carry identifiers
 * only, never data: the task reads what it needs itself.
 */
export const shopDomainSchema = z.string().refine(isValidShopDomain, { message: "must be a myshopify.com domain" });

export const shopAccessCheckPayload = z.object({
  shopDomain: shopDomainSchema,
  reason: z.enum(["install", "reconnect", "import", "manual"]),
});
export type ShopAccessCheckPayload = z.infer<typeof shopAccessCheckPayload>;

export const shopImportPayload = z.object({
  importId: z.uuid(),
  shopDomain: shopDomainSchema,
});
export type ShopImportPayload = z.infer<typeof shopImportPayload>;

export const complianceExportPayload = z.object({
  requestId: z.uuid(),
});
export type ComplianceExportPayload = z.infer<typeof complianceExportPayload>;
