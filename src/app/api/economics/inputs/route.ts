import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api/require-user";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { MERCHANT_INPUT_KEYS, type MerchantInputKey } from "@/modules/economics/inputs";
import { economicsInputs, saveEconomicsInputs, type MerchantInputChange } from "@/modules/economics/repository";
import { shopKeyFor } from "@/modules/ingestion/repository";
import { currentWorkspaceFor } from "@/modules/workspaces/current";

/**
 * The merchant's economics inputs: costs, expected rates and advertising limits (Phase 4, task 8), shop-wide or, for
 * the keys that allow it, for one product or one variant (finalisation: a confirmed zero unit cost, landed cost per
 * unit). Values are validated again by the database (save_economics_inputs), which also checks that the product is
 * the shop's and the variant is the product's; a value left blank is cleared and becomes unknown, never zero.
 * "None" is an explicit confirmation that a cost does not apply.
 */
const shopifyId = (value: unknown): number | null | undefined =>
  value === undefined || value === null ? undefined : Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;
async function shopFor(userId: string) {
  const workspace = await currentWorkspaceFor(userId);
  if (!workspace || workspace.status !== "active" || !workspace.shop_domain) return null;
  return shopKeyFor(workspace.shop_domain);
}

export async function GET(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const shopKey = await shopFor(auth.userId);
  if (shopKey === null) return NextResponse.json({ error: "Connect your Shopify store first" }, { status: 409 });
  // ?product=<id>: that product's own and its variants' inputs; otherwise the shop-wide ones.
  const raw = new URL(request.url).searchParams.get("product");
  const productId = raw === null ? undefined : shopifyId(/^\d{1,16}$/.test(raw) ? Number(raw) : -1);
  if (productId === null) return NextResponse.json({ error: "Invalid product" }, { status: 400 });
  const stored = await economicsInputs(shopKey, productId === undefined ? [] : [productId]);
  return NextResponse.json({ currency: stored.currency,
    inputs: stored.inputs.filter((i) => (productId === undefined ? i.product_id === 0 : i.product_id === productId)) });
}

export async function PUT(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const limited = await enforceRateLimit({ action: "economics:inputs", identifier: auth.userId, limit: 30, windowSeconds: 600 });
  if (!limited.ok) return limited.response;
  const shopKey = await shopFor(auth.userId);
  if (shopKey === null) return NextResponse.json({ error: "Connect your Shopify store first" }, { status: 409 });
  const body = (await request.json().catch(() => null)) as { changes?: unknown } | null;
  if (!body || !Array.isArray(body.changes) || body.changes.length > 50) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const changes: MerchantInputChange[] = [];
  for (const raw of body.changes) {
    const c = (raw ?? {}) as { key?: unknown; value?: unknown; state?: unknown; product_id?: unknown; variant_id?: unknown };
    if (!MERCHANT_INPUT_KEYS.includes(c.key as MerchantInputKey)) return NextResponse.json({ error: "Unknown input" }, { status: 400 });
    const key = c.key as MerchantInputKey;
    const productId = shopifyId(c.product_id);
    const variantId = shopifyId(c.variant_id);
    if (productId === null || variantId === null || (variantId !== undefined && productId === undefined)) {
      return NextResponse.json({ error: "Invalid product or variant" }, { status: 400 });
    }
    const scope = { ...(productId !== undefined ? { product_id: productId } : {}), ...(variantId !== undefined ? { variant_id: variantId } : {}) };
    if (c.state === "cleared") { changes.push({ ...scope, key, state: "cleared" }); continue; }
    if (c.state !== "merchant_entered" && c.state !== "confirmed_none" && c.state !== "merchant_estimate") {
      return NextResponse.json({ error: "Invalid input state" }, { status: 400 });
    }
    if (typeof c.value !== "number" || !Number.isFinite(c.value) || c.value < 0) return NextResponse.json({ error: `Invalid value for ${key}` }, { status: 400 });
    changes.push({ ...scope, key, value: c.state === "confirmed_none" ? 0 : c.value, state: c.state });
  }
  try {
    const saved = await saveEconomicsInputs(shopKey, changes, auth.userId);
    return NextResponse.json(saved);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const reason = /economics_inputs_invalid: (.*)$/.exec(message)?.[1];
    if (reason) return NextResponse.json({ error: `Not saved: ${reason}` }, { status: 400 });
    console.error("Economics inputs save failed", message);
    return NextResponse.json({ error: "Your costs could not be saved. Please retry." }, { status: 503 });
  }
}
