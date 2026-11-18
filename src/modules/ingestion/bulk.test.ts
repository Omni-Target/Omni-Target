import { describe, expect, it, vi } from "vitest";
import {
  bulkPhase,
  getBulkOperation,
  openBulkResult,
  pollDelayMs,
  RESULT_URL_TTL_MS,
  ResultUnavailableError,
  startBulkQuery,
  type BulkOperation,
  type Gql,
} from "./bulk";
import { gidType, parseGid } from "./gid";

const gqlReturning = (data: unknown) => {
  const fn = vi.fn<(query: string, variables?: Record<string, unknown>) => Promise<unknown>>(async () => data);
  return { fn, gql: fn as unknown as Gql };
};
const operation = (overrides: Partial<BulkOperation> = {}): BulkOperation => ({
  id: "gid://shopify/BulkOperation/77", status: "COMPLETED", errorCode: null, objectCount: 10, rootObjectCount: 4,
  fileSize: 1024, url: "https://storage.example/result.jsonl", partialDataUrl: null,
  createdAt: "2026-11-18T10:00:00Z", completedAt: "2026-11-18T10:05:00Z", ...overrides,
});

describe("Shopify global IDs", () => {
  it("parses numeric IDs of the expected type only", () => {
    expect(parseGid("gid://shopify/Order/450789469")).toBe(450789469);
    expect(parseGid("gid://shopify/Order/450789469", "Order")).toBe(450789469);
    expect(parseGid("gid://shopify/Order/450789469", "Customer")).toBeNull();
    expect(parseGid("gid://shopify/LineItem/1?foo=bar", "LineItem")).toBe(1);
    expect(parseGid("gid://shopify/Order/99999999999999999999")).toBeNull();
    expect(parseGid("Order/1")).toBeNull();
    expect(parseGid(12)).toBeNull();
    expect(gidType("gid://shopify/ProductVariant/3")).toBe("ProductVariant");
  });
});

describe("bulk operations (Phase 2 task 4)", () => {
  it("starts a query with groupObjects true, after the Level 2 guard", async () => {
    const { fn, gql } = gqlReturning({ bulkOperationRunQuery: { bulkOperation: { id: "gid://shopify/BulkOperation/77" }, userErrors: [] } });
    expect(await startBulkQuery(gql, "{ products { edges { node { id title } } } }")).toEqual({
      outcome: "started", id: "gid://shopify/BulkOperation/77", numericId: 77,
    });
    expect(fn.mock.calls[0][0]).toContain("groupObjects: true");
    expect(fn.mock.calls[0][1]).toEqual({ query: "{ products { edges { node { id title } } } }" });
    await expect(startBulkQuery(gql, "{ customers { edges { node { id email } } } }")).rejects.toThrow(/Level 2/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reports a full slot as busy and anything else as rejected", async () => {
    expect(await startBulkQuery(gqlReturning({ bulkOperationRunQuery: { bulkOperation: null, userErrors: [{ message: "A bulk query operation for this app and shop is already in progress", code: "OPERATION_IN_PROGRESS" }] } }).gql, "{ products { edges { node { id } } } }"))
      .toEqual({ outcome: "busy" });
    expect(await startBulkQuery(gqlReturning({ bulkOperationRunQuery: { bulkOperation: null, userErrors: [{ message: "Invalid bulk query", code: "INVALID" }] } }).gql, "{ products { edges { node { id } } } }"))
      .toEqual({ outcome: "rejected", errors: ["Invalid bulk query"] });
  });

  it("recognises bulk operations not enabled for the app (Shopify nulls the mutation with ACCESS_DENIED)", async () => {
    expect(await startBulkQuery(gqlReturning({ bulkOperationRunQuery: null }).gql, "{ products { edges { node { id } } } }"))
      .toEqual({ outcome: "not_enabled" });
  });

  it("reads an operation, with Shopify's 64-bit counts as numbers", async () => {
    const { gql } = gqlReturning({ node: { ...operation(), objectCount: "750000", rootObjectCount: "500000", fileSize: "123456789" } });
    expect(await getBulkOperation(gql, "gid://shopify/BulkOperation/77")).toMatchObject({ objectCount: 750_000, rootObjectCount: 500_000, fileSize: 123_456_789 });
    expect(await getBulkOperation(gqlReturning({ node: null }).gql, "gid://shopify/BulkOperation/1")).toBeNull();
  });

  it("decides the next step from the status, re-running expired or nearly expired results", () => {
    const completed = Date.parse("2026-11-18T10:05:00Z");
    expect(bulkPhase(operation({ status: "RUNNING" }))).toEqual({ phase: "pending" });
    expect(bulkPhase(operation(), completed + 60_000)).toEqual({ phase: "completed", url: "https://storage.example/result.jsonl" });
    expect(bulkPhase(operation({ url: null, objectCount: 0 }))).toEqual({ phase: "completed", url: null });
    expect(bulkPhase(operation(), completed + RESULT_URL_TTL_MS - 60_000)).toEqual({ phase: "rerun", reason: "url_expired" });
    expect(bulkPhase(operation({ status: "EXPIRED" }))).toEqual({ phase: "rerun", reason: "expired" });
    expect(bulkPhase(operation({ status: "CANCELED" }))).toEqual({ phase: "rerun", reason: "canceled" });
    expect(bulkPhase(operation({ status: "FAILED", errorCode: "ACCESS_DENIED", partialDataUrl: "https://x" })))
      .toEqual({ phase: "failed", reason: "access_denied", partial: true, accessDenied: true });
  });

  it("polls at 5 s, backing off to a minute", () => {
    expect([0, 1, 2, 3, 4, 10].map(pollDelayMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });

  it("treats a refused result URL as expired, so the operation is re-run", async () => {
    const respond = (status: number) => vi.fn(async () => new Response(status === 200 ? "{}\n" : "denied", { status })) as unknown as typeof fetch;
    await expect(openBulkResult("https://x", respond(403))).rejects.toMatchObject({ name: "ResultUnavailableError", reason: "expired" });
    await expect(openBulkResult("https://x", respond(500))).rejects.toBeInstanceOf(ResultUnavailableError);
    await expect(openBulkResult("https://x", respond(500))).rejects.toMatchObject({ reason: "http_error", status: 500 });
    expect(await openBulkResult("https://x", respond(200))).toBeInstanceOf(ReadableStream);
  });
});
