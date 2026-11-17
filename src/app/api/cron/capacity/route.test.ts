import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ capture: vi.fn(), failure: vi.fn(), alert: vi.fn() }));
vi.mock("@/modules/capacity/repository", () => ({ captureCapacitySnapshot: h.capture }));
vi.mock("@/lib/observability/capture", () => ({ captureBackgroundFailure: h.failure, captureOperationalAlert: h.alert }));

import { GET } from "./route";

const MIB = 1024 * 1024;
const call = (auth = "Bearer cron-secret") => GET(new Request("https://app.test/api/cron/capacity", { headers: { authorization: auth } }));
const snapshotAt = (megabytes: number) => ({
  captured_at: "2026-11-17T05:15:00Z", database_bytes: megabytes * MIB, public_bytes: (megabytes - 13) * MIB, quota_bytes: 500 * MIB,
  used_share: megabytes / 500, largest: [{ table: "order_line_items", rows: 1, heap: 1, indexes: 1, total: 2 }],
});

describe("GET /api/cron/capacity", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
    delete process.env.DATABASE_QUOTA_MB;
    for (const fn of Object.values(h)) fn.mockReset();
  });

  it("refuses without the cron secret", async () => {
    expect((await call("Bearer wrong")).status).toBe(401);
    expect(h.capture).not.toHaveBeenCalled();
  });

  it("records the snapshot against the configured quota and stays quiet below 60%", async () => {
    process.env.DATABASE_QUOTA_MB = "500";
    h.capture.mockResolvedValue(snapshotAt(120));
    const response = await call();
    expect(response.status).toBe(200);
    expect(h.capture).toHaveBeenCalledWith(500 * MIB);
    expect(await response.json()).toMatchObject({ level: "ok" });
    expect(h.alert).not.toHaveBeenCalled();
  });

  it("warns at 60% and raises an error at 75%", async () => {
    h.capture.mockResolvedValue(snapshotAt(320));
    expect(await (await call()).json()).toMatchObject({ level: "warning" });
    expect(h.alert).toHaveBeenLastCalledWith("capacity-snapshot", "Database at 64% of its 500 MB quota", "warning", expect.objectContaining({ quota_bytes: 500 * MIB }));

    h.capture.mockResolvedValue(snapshotAt(400));
    expect(await (await call()).json()).toMatchObject({ level: "critical" });
    expect(h.alert).toHaveBeenLastCalledWith("capacity-snapshot", "Database at 80% of its 500 MB quota", "error", expect.anything());
  });

  it("reports a failed snapshot, and a misconfigured quota, as failures", async () => {
    h.capture.mockRejectedValue(new Error("database unavailable"));
    expect((await call()).status).toBe(500);
    expect(h.failure).toHaveBeenCalledWith("capacity-snapshot", expect.any(Error));

    process.env.DATABASE_QUOTA_MB = "lots";
    expect((await call()).status).toBe(500);
  });
});
