// Read-only schema/capability smoke test. Prints no tokens or order/customer data.
// Usage: node --env-file=.env.local scripts/verify-shopify-return-query.mjs KASA
import { createClient } from "@supabase/supabase-js";

const needle = (process.argv[2] || "").toLowerCase().trim();
if (!needle) throw new Error("Pass a connected store-name fragment to verify");

const client = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
const { data, error } = await client.from("user_integrations")
  .select("clerk_user_id,store_snapshot")
  .not("shopify_access_token", "is", null).limit(100);
if (error) throw new Error(`Integration lookup failed: ${error.code || error.message}`);
const match = (data || []).find((candidate) =>
  String(candidate.store_snapshot?.store?.name || "").toLowerCase().includes(needle));
if (!match) throw new Error("Matching connected store not found");
const { data: row, error: tokenError } = await client.from("user_integrations")
  .select("shopify_store_url,shop_domain,shopify_access_token,token_expires_at,shopify_token_expires_at")
  .eq("clerk_user_id", match.clerk_user_id).single();
if (tokenError || !row) throw new Error("Matching Shopify credentials unavailable");
const expiry = row.token_expires_at || row.shopify_token_expires_at;
if (expiry && Date.parse(expiry) <= Date.now()) {
  process.stdout.write(JSON.stringify({ status: "token_expired", one_order_query_succeeded: false }));
  process.exit(1);
}
const hosts = [row.shopify_store_url, row.shop_domain].filter(Boolean)
  .map((value) => String(value).replace(/^https?:\/\//, "").split("/")[0]);
const host = hosts.find((value) => value.endsWith(".myshopify.com")) || hosts[0];
if (!host || !row.shopify_access_token) throw new Error("Shopify host or token unavailable");

const now = Date.now();
const from = new Date(now - 365 * 86_400_000).toISOString().slice(0, 10);
const until = new Date(now - 60 * 86_400_000).toISOString().slice(0, 10);
const query = `query {
  orders(first: 1, query: "created_at:>=${from} created_at:<${until}", sortKey: CREATED_AT) {
    nodes {
      id cancelledAt displayFinancialStatus
      lineItems(first: 1) { nodes { quantity product { legacyResourceId } } pageInfo { hasNextPage } }
      returns(first: 1) {
        nodes { returnLineItems(first: 1) {
          nodes { __typename ... on ReturnLineItem {
            processedQuantity returnReasonDefinition { name }
            fulfillmentLineItem { lineItem { quantity product { legacyResourceId } } }
          } }
          pageInfo { hasNextPage }
        } }
        pageInfo { hasNextPage }
      }
      refunds { refundLineItems(first: 1) {
        nodes { quantity lineItem { quantity product { legacyResourceId } } }
        pageInfo { hasNextPage }
      } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
const response = await fetch(`https://${host}/admin/api/2026-07/graphql.json`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": row.shopify_access_token },
  body: JSON.stringify({ query }),
  signal: AbortSignal.timeout(12_000),
});
const body = await response.json();
const rawErrors = body.errors;
const errors = Array.isArray(rawErrors)
  ? rawErrors.map((entry) => String(entry.message || entry).slice(0, 180))
  : rawErrors ? [String(JSON.stringify(rawErrors)).slice(0, 300)] : [];
process.stdout.write(JSON.stringify({
  status: response.status,
  host_kind: host.endsWith(".myshopify.com") ? "myshopify" : "custom",
  errors,
  one_order_query_succeeded: Boolean(body.data?.orders),
  order_count: body.data?.orders?.nodes?.length ?? null,
  has_next: body.data?.orders?.pageInfo?.hasNextPage ?? null,
}));
if (!response.ok || errors.length) process.exitCode = 1;
