import "server-only";
import { supabaseAdmin } from "@/platform/supabase";
import { currentWorkspaceFor } from "@/modules/workspaces/current";

/**
 * Workspace credits (Phase 1, task 5). Every change to a balance is one entry
 * in the append-only ledger, written by a database function from migration
 * 0021 in the same transaction as the balance and, for a purchase, its payment
 * record. This module only names those functions and types their results; it
 * never writes a balance itself. The actor is always the authenticated Clerk
 * user id, never a value from the browser.
 */

export class CreditError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CreditError";
  }
}

/** Business errors raised by the 0021 functions, passed through by code. */
const KNOWN_CODES = [
  "no_credits", "insufficient_credits", "workspace_access_denied", "workspace_inactive", "shop_not_connected",
  "idempotency_conflict", "intent_plan_mismatch", "charge_already_attached", "payment_record_missing",
  "invalid_regeneration", "regeneration_product_changed", "regeneration_limit",
] as const;
export type CreditErrorCode = (typeof KNOWN_CODES)[number];

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) {
    const code = KNOWN_CODES.find((known) => error.message === known || error.message?.startsWith(`${known}:`));
    throw new CreditError(code ?? `${fn}_failed`);
  }
  return data as T;
}

export interface CreditStatus {
  workspaceId: string | null;
  shopDomain: string | null;
  balance: number;
  unlimitedUntil: string | null;
  isUnlimited: boolean;
}

const NO_WORKSPACE: CreditStatus = { workspaceId: null, shopDomain: null, balance: 0, unlimitedUntil: null, isUnlimited: false };

/** Balance and unlimited access of the user's current workspace (none: zero). */
export async function creditStatusFor(userId: string, preferredWorkspace?: string | null): Promise<CreditStatus> {
  const workspace = await currentWorkspaceFor(userId, preferredWorkspace);
  if (!workspace) return NO_WORKSPACE;
  const status = await rpc<{ balance: number; unlimited_until: string | null; is_unlimited: boolean }>(
    "workspace_credit_status", { p_workspace: workspace.workspace_id, p_actor: userId });
  return {
    workspaceId: workspace.workspace_id,
    shopDomain: workspace.shop_domain,
    balance: status.balance ?? 0,
    unlimitedUntil: status.unlimited_until,
    isUnlimited: status.is_unlimited === true,
  };
}

export type FreeCreditOutcome = "granted" | "already_granted" | "shop_already_granted" | "legacy_free_credit_used" | "workspace_inactive";

/** The one free credit for a newly connected workspace; once per workspace and per shop. */
export async function grantFreeCredit(workspaceId: string, actor: string): Promise<FreeCreditOutcome> {
  const result = await rpc<{ outcome: FreeCreditOutcome }>("grant_workspace_free_credit", { p_workspace: workspaceId, p_actor: actor });
  return result.outcome;
}

export type PaymentProvider = "shopify" | "stripe" | "paystack";

export interface IntentInput {
  workspaceId: string;
  actor: string;
  provider: PaymentProvider;
  planKey: string;
  kind: "one_time" | "subscription";
  credits: number;
  unlimitedDays: number;
  amount: number | null;
  currency: string | null;
  /** Known up front for Stripe and Paystack (our payments row id); Shopify's arrives later. */
  externalChargeId?: string | null;
}

/** Records who is buying what for which workspace, before any provider call. */
export async function createPurchaseIntent(input: IntentInput): Promise<{ intentId: string; shopDomain: string | null }> {
  const result = await rpc<{ intent_id: string; shop_domain: string | null }>("create_purchase_intent", {
    p_workspace: input.workspaceId, p_actor: input.actor, p_provider: input.provider, p_plan_key: input.planKey,
    p_kind: input.kind, p_credits: input.credits, p_unlimited_days: input.unlimitedDays, p_amount: input.amount,
    p_currency: input.currency, p_external_charge_id: input.externalChargeId ?? null,
  });
  return { intentId: result.intent_id, shopDomain: result.shop_domain };
}

export const attachIntentCharge = (intentId: string, chargeId: string) =>
  rpc<boolean>("attach_intent_charge", { p_intent: intentId, p_external_charge_id: chargeId });

export const failPurchaseIntent = (intentId: string, reason: string) =>
  rpc<boolean>("fail_purchase_intent", { p_intent: intentId, p_reason: reason });

export interface PurchaseIntent {
  id: string;
  workspace_id: string;
  purchaser_clerk_user_id: string;
  plan_key: string;
  credits: number;
  unlimited_days: number;
  status: string;
  shop_domain: string | null;
}

/** The intent a provider charge belongs to, with its shop's current domain. */
export async function intentForCharge(provider: PaymentProvider, externalId: string): Promise<PurchaseIntent | null> {
  const { data, error } = await supabaseAdmin
    .from("purchase_intents")
    .select("id, workspace_id, purchaser_clerk_user_id, plan_key, credits, unlimited_days, status, shops(myshopify_domain)")
    .eq("provider", provider)
    .eq("external_charge_id", externalId)
    .maybeSingle();
  if (error) throw new CreditError("intent_lookup_failed");
  if (!data) return null;
  const { shops, ...intent } = data as unknown as Omit<PurchaseIntent, "shop_domain"> & {
    shops: { myshopify_domain: string } | { myshopify_domain: string }[] | null;
  };
  const shop = Array.isArray(shops) ? shops[0] : shops;
  return { ...intent, shop_domain: shop?.myshopify_domain ?? null };
}

export type PurchaseOutcome = "granted" | "duplicate" | "not_creditable" | "needs_review" | "legacy_claimed" | "no_intent";

export interface PurchaseResult {
  outcome: PurchaseOutcome;
  purchase_id?: string;
  workspace_id?: string | null;
  ledger_entry_id?: number | null;
  balance?: number | null;
}

export interface ChargeReport {
  provider: PaymentProvider;
  externalId: string;
  planKey: string | null;
  providerStatus: string | null;
  test: boolean | null;
  creditable: boolean;
  amount: number | null;
  currency: string | null;
  providerCreatedAt: string | null;
  details?: Record<string, unknown>;
}

/** Settles a charge started by a purchase intent: credited to that intent's workspace, once. */
export function grantIntentPurchase(charge: ChargeReport): Promise<PurchaseResult> {
  return rpc<PurchaseResult>("grant_intent_purchase", {
    p_provider: charge.provider, p_external_id: charge.externalId, p_plan_key: charge.planKey,
    p_provider_status: charge.providerStatus, p_test: charge.test, p_creditable: charge.creditable,
    p_amount: charge.amount, p_currency: charge.currency, p_provider_created_at: charge.providerCreatedAt,
    p_details: charge.details ?? {},
  });
}

export interface ShopPurchaseReport extends Omit<ChargeReport, "provider"> {
  shopId: string;
  kind: "one_time" | "subscription_period";
  credits: number;
}

/**
 * Records a Shopify charge found by reconciliation. Its intent decides when it
 * has one; otherwise only an unambiguous binding period does, and anything else
 * stays unattributed for review.
 */
export function recordShopPurchase(report: ShopPurchaseReport): Promise<PurchaseResult> {
  return rpc<PurchaseResult>("record_shop_purchase", {
    p_shop: report.shopId, p_external_id: report.externalId, p_kind: report.kind, p_plan_key: report.planKey,
    p_credits: report.credits, p_provider_status: report.providerStatus, p_test: report.test,
    p_creditable: report.creditable, p_amount: report.amount, p_currency: report.currency,
    p_provider_created_at: report.providerCreatedAt, p_details: report.details ?? {},
  });
}

/** The shop id and reconciliation cursor for a domain (null cursor before the first page). */
export async function billingStateFor(domain: string): Promise<{ shopId: string; cursor: string | null } | null> {
  const { data, error } = await supabaseAdmin.from("shops").select("id, billing_sync_state(cursor)").eq("myshopify_domain", domain).maybeSingle();
  if (error) throw new CreditError("billing_state_failed");
  if (!data) return null;
  const state = (data as unknown as { billing_sync_state: { cursor: string | null } | { cursor: string | null }[] | null }).billing_sync_state;
  const row = Array.isArray(state) ? state[0] : state;
  return { shopId: data.id as string, cursor: row?.cursor ?? null };
}

/** Moves the cursor only from the value this run read; false means another run moved it. */
export const saveBillingCursor = (shopId: string, expected: string | null, cursor: string | null, completed: boolean, error: string | null = null) =>
  rpc<boolean>("save_billing_cursor", { p_shop: shopId, p_expected: expected, p_cursor: cursor, p_completed: completed, p_error: error });
