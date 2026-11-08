import { AsyncLocalStorage } from "node:async_hooks";
import { fetchWithRetry } from "../http";
import { shopifyAdminGraphqlUrl } from "../shopify-config";

export class ShopifyGraphqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyGraphqlError";
  }
}

interface GraphqlError {
  message?: string;
  path?: Array<string | number>;
  extensions?: { code?: string };
}

interface GraphqlEnvelope<T> {
  data?: T | null;
  errors?: GraphqlError[];
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      throttleStatus?: { currentlyAvailable?: number; restoreRate?: number };
    };
  };
}

const MAX_THROTTLE_RETRIES = 3;
const MIN_THROTTLE_WAIT_MS = 250;
const MAX_THROTTLE_WAIT_MS = 4_000;

const deniedFieldsScope = new AsyncLocalStorage<Set<string>>();

/**
 * Runs Shopify calls and reports which protected fields Shopify withheld from
 * them. Scoped per call chain, so concurrent capabilities and shops stay apart.
 */
export async function collectDeniedFields<R>(
  run: () => Promise<R>,
): Promise<{ value: R; deniedFields: string[] }> {
  const denied = new Set<string>();
  const value = await deniedFieldsScope.run(denied, run);
  return { value, deniedFields: [...denied] };
}

/** A denial of one field: Shopify nulls it and still returns the rest. */
const isFieldDenial = (error: GraphqlError) =>
  error.extensions?.code === "ACCESS_DENIED" && Boolean(error.path?.length);

const isThrottled = (error: GraphqlError) => error.extensions?.code === "THROTTLED";

/** List indexes are dropped so a field denied on every row is reported once. */
const fieldName = (path: Array<string | number>) =>
  path.filter((segment) => typeof segment === "string").join(".");

/** Waits for the cost Shopify says it is short of, within fixed bounds. */
function throttleWaitMs<T>(payload: GraphqlEnvelope<T>): number {
  const cost = payload.extensions?.cost;
  const restoreRate = cost?.throttleStatus?.restoreRate || 50;
  const shortfall = (cost?.requestedQueryCost || 0) - (cost?.throttleStatus?.currentlyAvailable || 0);
  const needed = Math.ceil((Math.max(shortfall, 0) / restoreRate) * 1000);
  return Math.min(Math.max(needed, MIN_THROTTLE_WAIT_MS), MAX_THROTTLE_WAIT_MS) + Math.floor(Math.random() * 150);
}

/**
 * Admin GraphQL query with Shopify's partial-failure semantics (ING-06):
 * a denied field is recorded and left null; THROTTLED backs off and retries;
 * anything else, including a denial of the whole query, is an error.
 */
export async function shopifyGraphql<T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetchWithRetry(
      shopifyAdminGraphqlUrl(shopDomain),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      },
      { timeoutMs: 12_000, retries: 1 },
    );

    if (!response.ok) {
      throw new ShopifyGraphqlError(`Shopify GraphQL HTTP ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as GraphqlEnvelope<T>;
    const errors = payload.errors ?? [];

    if (errors.some(isThrottled)) {
      if (attempt >= MAX_THROTTLE_RETRIES) throw new ShopifyGraphqlError("Shopify GraphQL throttled");
      await new Promise((resolve) => setTimeout(resolve, throttleWaitMs(payload)));
      continue;
    }

    const fatal = errors.filter((error) => !isFieldDenial(error));
    if (fatal.length) {
      throw new ShopifyGraphqlError(
        fatal.map((error) => error.message || "Unknown GraphQL error").join("; "),
      );
    }
    if (!payload.data) throw new ShopifyGraphqlError("Shopify GraphQL returned no data");

    const denied = deniedFieldsScope.getStore();
    for (const error of errors) denied?.add(fieldName(error.path ?? []));
    return payload.data;
  }
}
