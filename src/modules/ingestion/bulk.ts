/**
 * Shopify GraphQL Bulk Operations (Phase 2, task 4). The GraphQL executor is
 * injected, so this module is pure and testable without Shopify.
 *
 * - Up to five bulk queries run per shop at once (API 2026-01 and later).
 *   Shopify answers OPERATION_IN_PROGRESS beyond that; the caller waits.
 * - groupObjects is always true. API 2026-07 defaults it to false, and then
 *   a record's children need not follow it in the result file; the importer
 *   streams each record with its children in bounded memory, so it needs
 *   them grouped (jsonl.ts fails loudly if they are not).
 * - Completion: the bulk_operations/finish webhook when it arrives, polling
 *   otherwise (delivery is not guaranteed).
 * - Result URLs are signed for 7 days. They are never stored: they are read
 *   again from the operation, and an expired one means re-running it.
 */
import { assertLevel1Query } from "./access";
import { parseGid } from "./gid";

export type Gql = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

export const MAX_CONCURRENT_BULK_QUERIES = 5;
export const RESULT_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Margin before the URL's expiry within which it is no longer relied on. */
export const RESULT_URL_MARGIN_MS = 6 * 60 * 60 * 1000;

export type BulkStatus = "CREATED" | "RUNNING" | "COMPLETED" | "CANCELING" | "CANCELED" | "FAILED" | "EXPIRED";

export interface BulkOperation {
  id: string;
  status: BulkStatus;
  errorCode: string | null;
  objectCount: number;
  rootObjectCount: number;
  fileSize: number | null;
  url: string | null;
  partialDataUrl: string | null;
  createdAt: string;
  completedAt: string | null;
}

const RUN_MUTATION = `mutation RunBulkQuery($query: String!) {
  bulkOperationRunQuery(query: $query, groupObjects: true) {
    bulkOperation { id status }
    userErrors { field message code }
  }
}`;

const OPERATION_QUERY = `query BulkOperation($id: ID!) {
  node(id: $id) {
    ... on BulkOperation { id status errorCode objectCount rootObjectCount fileSize url partialDataUrl createdAt completedAt }
  }
}`;

const CANCEL_MUTATION = `mutation CancelBulk($id: ID!) {
  bulkOperationCancel(id: $id) { bulkOperation { id status } userErrors { field message } }
}`;

export type StartResult =
  | { outcome: "started"; id: string; numericId: number }
  | { outcome: "busy" }
  | { outcome: "not_enabled" }
  | { outcome: "rejected"; errors: string[] };

/**
 * Starts a bulk query. Every query passes the Level 2 guard first.
 *
 * Shopify refuses the mutation itself (ACCESS_DENIED, field nulled) until bulk
 * operations are enabled for the app in the Dev Dashboard, and again after 31
 * days without a bulk operation: that is "not_enabled", for an operator to fix.
 */
export async function startBulkQuery(gql: Gql, query: string): Promise<StartResult> {
  assertLevel1Query(query);
  const data = await gql<{
    bulkOperationRunQuery: { bulkOperation: { id: string } | null; userErrors: Array<{ message: string; code?: string | null }> } | null;
  }>(RUN_MUTATION, { query });
  if (!data.bulkOperationRunQuery) return { outcome: "not_enabled" };
  const { bulkOperation, userErrors } = data.bulkOperationRunQuery;
  if (userErrors.some((error) => error.code === "OPERATION_IN_PROGRESS")) return { outcome: "busy" };
  if (!bulkOperation || userErrors.length) return { outcome: "rejected", errors: userErrors.map((error) => error.message).slice(0, 5) };
  const numericId = parseGid(bulkOperation.id, "BulkOperation");
  if (numericId === null) return { outcome: "rejected", errors: ["unexpected bulk operation id"] };
  return { outcome: "started", id: bulkOperation.id, numericId };
}

const toNumber = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

export async function getBulkOperation(gql: Gql, id: string): Promise<BulkOperation | null> {
  const data = await gql<{ node: (Omit<BulkOperation, "objectCount" | "rootObjectCount" | "fileSize"> & Record<string, unknown>) | null }>(OPERATION_QUERY, { id });
  const node = data.node;
  if (!node || !node.id) return null;
  return {
    id: node.id,
    status: node.status,
    errorCode: (node.errorCode as string | null) ?? null,
    objectCount: toNumber(node.objectCount),
    rootObjectCount: toNumber(node.rootObjectCount),
    fileSize: node.fileSize === null || node.fileSize === undefined ? null : Number(node.fileSize),
    url: (node.url as string | null) ?? null,
    partialDataUrl: (node.partialDataUrl as string | null) ?? null,
    createdAt: node.createdAt,
    completedAt: (node.completedAt as string | null) ?? null,
  };
}

export async function cancelBulkOperation(gql: Gql, id: string): Promise<void> {
  await gql(CANCEL_MUTATION, { id });
}

export type BulkPhase =
  | { phase: "pending" }
  | { phase: "completed"; url: string | null }
  | { phase: "rerun"; reason: "expired" | "canceled" | "url_expired" }
  | { phase: "failed"; reason: string; partial: boolean; accessDenied: boolean };

/**
 * What the importer should do next with an operation. A completed operation
 * with no objects has no URL: nothing to import. A result URL close to its
 * 7-day expiry is not relied on: the operation is re-run.
 */
export function bulkPhase(operation: BulkOperation, now: number = Date.now()): BulkPhase {
  switch (operation.status) {
    case "CREATED":
    case "RUNNING":
    case "CANCELING":
      return { phase: "pending" };
    case "COMPLETED": {
      if (!operation.url) return { phase: "completed", url: null };
      const completed = Date.parse(operation.completedAt ?? operation.createdAt);
      if (Number.isFinite(completed) && now > completed + RESULT_URL_TTL_MS - RESULT_URL_MARGIN_MS) {
        return { phase: "rerun", reason: "url_expired" };
      }
      return { phase: "completed", url: operation.url };
    }
    case "EXPIRED":
      return { phase: "rerun", reason: "expired" };
    case "CANCELED":
      return { phase: "rerun", reason: "canceled" };
    case "FAILED":
    default:
      return {
        phase: "failed",
        reason: (operation.errorCode ?? "unknown").toLowerCase(),
        partial: Boolean(operation.partialDataUrl),
        accessDenied: operation.errorCode === "ACCESS_DENIED",
      };
  }
}

/** Poll interval: 5 s at first, doubling to a minute. */
export function pollDelayMs(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempt), 60_000);
}

export class ResultUnavailableError extends Error {
  constructor(readonly reason: "expired" | "http_error", readonly status?: number) {
    super(`Bulk result unavailable: ${reason}${status ? ` (${status})` : ""}`);
    this.name = "ResultUnavailableError";
  }
}

/**
 * Opens a result file as a byte stream. Shopify's signed URL answers 403 or
 * 404 once expired; the importer then re-runs the operation.
 *
 * The returned stream holds the Response: Node's fetch cancels a body whose
 * Response has been garbage-collected, which ends the stream early and
 * silently if the caller awaits anything before reading (as staging does).
 */
export async function openBulkResult(url: string, fetchImpl: typeof fetch = fetch): Promise<ReadableStream<Uint8Array>> {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (response.status === 403 || response.status === 404 || response.status === 410) {
    throw new ResultUnavailableError("expired", response.status);
  }
  if (!response.ok || !response.body) throw new ResultUnavailableError("http_error", response.status);
  const reader = response.body.getReader();
  const held = { response };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        held.response = null as unknown as Response;
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
