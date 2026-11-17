import { describe, expect, it } from "vitest";
import {
  aggregateRefreshRange,
  COHORT_FINAL_AFTER_DAYS,
  monthsBefore,
  ORDER_RETENTION_MONTHS,
  orderHistoryWindow,
  retentionCutoff,
} from "./policy";

const at = (iso: string) => new Date(iso);

describe("retention window (Task 11 decision 1)", () => {
  it("keeps 24 months of detailed orders", () => {
    expect(ORDER_RETENTION_MONTHS).toBe(24);
    expect(retentionCutoff(at("2026-11-18T09:30:00.000Z")).toISOString()).toBe("2024-11-18T09:30:00.000Z");
  });

  it("clamps to the month's last day, as Postgres interval arithmetic does", () => {
    expect(monthsBefore(at("2028-02-29T00:00:00.000Z"), 24).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(monthsBefore(at("2026-03-31T12:00:00.000Z"), 1).toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(monthsBefore(at("2026-01-15T00:00:00.000Z"), 1).toISOString()).toBe("2025-12-15T00:00:00.000Z");
  });
});

describe("order history the import may read (Task 11 decision 6)", () => {
  const now = at("2026-11-18T00:00:00.000Z");

  it("reads the full retention window only with read_all_orders", () => {
    expect(orderHistoryWindow(["read_orders", "read_all_orders", "read_products"], now)).toEqual({
      from: at("2024-11-18T00:00:00.000Z"), basis: "retention_window", missingScope: null,
    });
  });

  it("assumes no more than 60 days without read_all_orders, and names the missing scope", () => {
    expect(orderHistoryWindow(["read_orders", "read_products"], now)).toEqual({
      from: at("2026-09-19T00:00:00.000Z"), basis: "read_orders_only", missingScope: "read_all_orders",
    });
  });

  it("treats write_orders as read_orders", () => {
    expect(orderHistoryWindow(["write_orders"], now).basis).toBe("read_orders_only");
  });

  it("reads nothing without an orders scope, even if read_all_orders is listed", () => {
    expect(orderHistoryWindow(["read_all_orders"], now)).toEqual({ from: null, basis: "no_order_access", missingScope: "read_orders" });
    expect(orderHistoryWindow([], now).basis).toBe("no_order_access");
  });
});

describe("aggregate refresh range (Task 11 decision 5)", () => {
  it("covers every month whose cohort is not final, through the current month", () => {
    expect(COHORT_FINAL_AFTER_DAYS).toBe(485);
    // 485 days before 2026-11-18 is 2025-07-21.
    expect(aggregateRefreshRange(at("2026-11-18T00:00:00.000Z"))).toEqual({ from: "2025-07-01", to: "2026-11-01" });
  });
});
