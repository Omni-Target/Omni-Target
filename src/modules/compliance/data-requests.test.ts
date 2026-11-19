import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateCredentialKey, resetCredentialKeyringForTests } from "@/platform/credentials/crypto";
import { maintainComplianceExports, runDataRequestExport, settleClosedExports, type MaintenanceDeps } from "./data-requests";
import { openExport } from "./export-file";
import type { DueExportAction } from "./exports-repository";

vi.mock("@/platform/supabase", () => ({ supabaseAdmin: {} }));

const REQUEST = "7f6f3a52-3a4b-4c55-9e7a-0d7b8f1c2a10";
const claimed = {
  outcome: "claimed" as const, shop_key: 2, shop_domain: "s.myshopify.com", shopify_shop_id: 9, customer_id: 501, order_ids: [12],
  received_at: "2026-11-01T00:00:00Z", due_at: "2026-12-01T00:00:00Z",
};

function harness() {
  const files = new Map<string, { body: Buffer; lastModified: Date }>();
  const repo = {
    claimExport: vi.fn(async () => claimed),
    exportCustomer: vi.fn(async () => ({ shopify_id: 501, orders_count: 2 })),
    exportOrders: vi.fn(async (_r: string, _run: string, after: number) =>
      after === 0 ? { orders: [{ shopify_id: 11, line_items: [{}], refunds: [], returns: [] }], next_after: 11 } : { orders: [{ shopify_id: 12, line_items: [], refunds: [{}], returns: [] }], next_after: null }),
    exportRelated: vi.fn(async () => ({ meta_conversion_events: [{ order_id: "11" }], pending_webhook_payloads: [] })),
    recordExport: vi.fn(async () => ({ outcome: "ready" as const, owner_clerk_user_id: "user_owner", shop_domain: "s.myshopify.com", expires_at: "2026-12-02T00:00:00Z" })),
    failExport: vi.fn(async () => ({ outcome: "pending" })),
    markExportNotified: vi.fn(async () => ({ outcome: "notified" as const })),
    exportOwner: vi.fn(async () => ({ status: "ready", shop_domain: "s.myshopify.com", expires_at: "2026-12-02T00:00:00Z", owner_clerk_user_id: "user_owner" })),
    closeExport: vi.fn(async () => ({ outcome: "closed" as const })),
    exportFileDeleted: vi.fn(async () => ({ outcome: "deleted" })),
    markEscalated: vi.fn(async () => ({ outcome: "escalated" })),
    exportsDue: vi.fn(async (): Promise<DueExportAction[]> => []),
    referencedExportFiles: vi.fn(async (keys: string[]) => new Set(keys.filter((key) => key.includes("named")))),
  };
  const store = {
    put: vi.fn(async (key: string, body: Buffer) => { files.set(key, { body, lastModified: new Date() }); }),
    get: vi.fn(async (key: string) => files.get(key)!.body),
    remove: vi.fn(async (key: string) => { files.delete(key); }),
    list: vi.fn(async () => [...files].map(([key, file]) => ({ key, lastModified: file.lastModified }))),
  };
  const deps: MaintenanceDeps = {
    repo: repo as unknown as MaintenanceDeps["repo"], store,
    notifyOwner: vi.fn(async () => {}), dispatch: vi.fn(async () => "run_2"), alert: vi.fn(), now: () => Date.parse("2026-11-20T12:00:00Z"),
  };
  return { repo, store, files, deps };
}
const action = (overrides: Partial<DueExportAction>): DueExportAction =>
  ({ request_id: REQUEST, shop_domain: "s.myshopify.com", action: "dispatch", reason: null, object_key: null, due_at: "2026-12-01T00:00:00Z", level: null, ...overrides });

beforeEach(() => {
  vi.stubEnv("APP_ENCRYPTION_KEY", generateCredentialKey());
  vi.stubEnv("APP_ENCRYPTION_KEY_VERSION", "1");
  resetCredentialKeyringForTests();
});

describe("customer data export run (task 9)", () => {
  it("exports every page into one encrypted file, records it, and tells the owner", async () => {
    const { repo, store, files, deps } = harness();
    const report = await runDataRequestExport(REQUEST, "run_1", deps);
    expect(report).toMatchObject({ outcome: "ready", notified: true, counts: { customer: 1, orders: 2, line_items: 1, refunds: 1, meta_conversion_events: 1 } });
    expect(repo.exportOrders.mock.calls.map((call) => call[2])).toEqual([0, 11]);
    const [[key, file]] = [...files].map(([k, f]) => [k, f.body] as const);
    expect(repo.recordExport).toHaveBeenCalledWith(REQUEST, "run_1", expect.objectContaining({ objectKey: key, bytes: file.length, keyVersion: 1 }));
    const document = JSON.parse(openExport(file, REQUEST).toString("utf8"));
    expect(document.orders.map((o: { shopify_id: number }) => o.shopify_id)).toEqual([11, 12]);
    expect(document.request).toMatchObject({ customer_id: 501, orders_requested: [12] });
    expect(deps.notifyOwner).toHaveBeenCalledWith("user_owner", { shopDomain: "s.myshopify.com", expiresAt: "2026-12-02T00:00:00Z" });
    expect(repo.markExportNotified).toHaveBeenCalledWith(REQUEST);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("deletes its file when recording is refused because the customer was redacted meanwhile", async () => {
    const { repo, files, deps } = harness();
    repo.recordExport.mockResolvedValueOnce({ outcome: "withdrawn" } as never);
    expect(await runDataRequestExport(REQUEST, "run_1", deps)).toEqual({ outcome: "withdrawn" });
    expect(files.size).toBe(0);
    expect(deps.notifyOwner).not.toHaveBeenCalled();
  });

  it("does nothing unless it holds the claim", async () => {
    const { repo, store, deps } = harness();
    repo.claimExport.mockResolvedValueOnce({ outcome: "withdrawn" } as never);
    expect(await runDataRequestExport(REQUEST, "run_1", deps)).toEqual({ outcome: "withdrawn" });
    expect(repo.exportCustomer).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it("gives the export back for a retry, and leaves no file, when it fails", async () => {
    const { repo, files, deps } = harness();
    repo.exportRelated.mockRejectedValueOnce(new Error("statement timeout"));
    await expect(runDataRequestExport(REQUEST, "run_1", deps)).rejects.toThrow(/statement timeout/);
    expect(repo.failExport).toHaveBeenCalledWith(REQUEST, "run_1", "statement timeout");
    expect(files.size).toBe(0);
  });

  it("keeps a ready export when the owner cannot be emailed; maintenance retries the notice", async () => {
    const { repo, deps } = harness();
    vi.mocked(deps.notifyOwner).mockRejectedValueOnce(new Error("Email not sent"));
    expect(await runDataRequestExport(REQUEST, "run_1", deps)).toMatchObject({ outcome: "ready", notified: false });
    expect(repo.markExportNotified).not.toHaveBeenCalled();
    expect(repo.failExport).not.toHaveBeenCalled();
  });
});

describe("compliance maintenance (task 9)", () => {
  it("withdraws, expires, notifies, dispatches and escalates, then deletes closed files and orphans past the grace period", async () => {
    const { repo, store, files, deps } = harness();
    files.set("compliance-exports/named.bin", { body: Buffer.from("x"), lastModified: new Date("2026-11-01") });
    files.set("compliance-exports/orphan-old.bin", { body: Buffer.from("x"), lastModified: new Date("2026-11-20T10:00:00Z") });
    files.set("compliance-exports/orphan-new.bin", { body: Buffer.from("x"), lastModified: new Date("2026-11-20T11:30:00Z") });
    files.set("compliance-exports/closed.bin", { body: Buffer.from("x"), lastModified: new Date("2026-11-01") });
    repo.exportsDue
      .mockResolvedValueOnce([
        action({ request_id: "w", action: "withdraw", reason: "shop_redacted" }),
        action({ request_id: "x", action: "expire", reason: "expired", object_key: "compliance-exports/closed.bin" }),
        action({ request_id: "n", action: "notify" }),
        action({ request_id: "d", action: "dispatch" }),
        action({ request_id: "e", action: "escalate", level: 2 }),
      ])
      .mockResolvedValueOnce([action({ request_id: "x", action: "delete_file", reason: "expired", object_key: "compliance-exports/closed.bin" })]);
    repo.referencedExportFiles.mockImplementationOnce(async (keys: string[]) => new Set(keys.filter((key) => key.includes("named"))));

    const report = await maintainComplianceExports(deps);
    expect(repo.closeExport.mock.calls).toEqual([["w", "shop_redacted"], ["x", "expired"]]);
    expect(deps.notifyOwner).toHaveBeenCalledWith("user_owner", expect.objectContaining({ shopDomain: "s.myshopify.com" }));
    expect(deps.dispatch).toHaveBeenCalledWith("d", "s.myshopify.com");
    expect(deps.alert).toHaveBeenCalledWith(2, { requestId: "e", shopDomain: "s.myshopify.com", dueAt: "2026-12-01T00:00:00Z" });
    expect(repo.markEscalated).toHaveBeenCalledWith("e", 2);
    expect(repo.exportFileDeleted).toHaveBeenCalledWith("x", "compliance-exports/closed.bin");
    expect([...files.keys()].sort()).toEqual(["compliance-exports/named.bin", "compliance-exports/orphan-new.bin"]);
    expect(report).toMatchObject({ withdrawn: 1, expired: 1, notified: 1, dispatched: 1, escalated: 1, filesDeleted: 1, orphansDeleted: 1, failures: [] });
    expect(store.remove).toHaveBeenCalledTimes(2);
  });

  it("records a failed action and carries on", async () => {
    const { repo, deps } = harness();
    repo.exportsDue.mockResolvedValueOnce([action({ request_id: "a", action: "withdraw", reason: "workspace_deleted" }), action({ request_id: "b", action: "dispatch" })]);
    repo.closeExport.mockRejectedValueOnce(new Error("db down"));
    const report = await maintainComplianceExports(deps);
    expect(report.failures).toEqual([{ requestId: "a", action: "withdraw", error: "db down" }]);
    expect(report.dispatched).toBe(1);
  });

  it("settles one shop's withdrawals and files right after a redaction, and no other shop's", async () => {
    const { repo, files, deps } = harness();
    files.set("compliance-exports/mine.bin", { body: Buffer.from("x"), lastModified: new Date() });
    files.set("compliance-exports/theirs.bin", { body: Buffer.from("x"), lastModified: new Date() });
    repo.exportsDue
      .mockResolvedValueOnce([action({ request_id: "m", action: "withdraw", reason: "shop_redacted" }), action({ request_id: "o", shop_domain: "other.myshopify.com", action: "withdraw", reason: "shop_redacted" })])
      .mockResolvedValueOnce([
        action({ request_id: "m", action: "delete_file", object_key: "compliance-exports/mine.bin" }),
        action({ request_id: "o", shop_domain: "other.myshopify.com", action: "delete_file", object_key: "compliance-exports/theirs.bin" }),
      ]);
    const report = await settleClosedExports("s.myshopify.com", deps);
    expect(repo.closeExport.mock.calls).toEqual([["m", "shop_redacted"]]);
    expect([...files.keys()]).toEqual(["compliance-exports/theirs.bin"]);
    expect(report).toMatchObject({ withdrawn: 1, filesDeleted: 1, failures: [] });
  });
});
