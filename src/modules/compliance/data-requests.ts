import "server-only";
import { createLogger } from "@/platform/logger";
import { buildExportDocument, exportObjectKey, sealExport } from "./export-file";
import type { ExportStore } from "./export-store";
import type * as Repository from "./exports-repository";

/**
 * Customer data requests (Phase 2, task 9; decision 4), run by Trigger.dev.
 *
 * Export: a run claims the request's export, reads the customer's data page by
 * page (each page one database call), writes one encrypted file under a fresh
 * key, and records it. If the customer was redacted, or another run took the
 * export over, recording is refused and the file deleted. The workspace owner
 * is then emailed (no customer data in the email); that completes the request.
 *
 * Maintenance (hourly): withdraws exports of shops or workspaces being
 * deleted, deletes the files of closed exports and any file no export names,
 * escalates requests nearing Shopify's 30-day deadline, expires exports after
 * 30 days, retries notifications, and re-dispatches stalled exports.
 */
const log = createLogger({ module: "compliance-exports" });
const MAX_ORDER_PAGES = 1_000;

export type ExportsRepository = Pick<typeof Repository,
  | "claimExport" | "exportCustomer" | "exportOrders" | "exportRelated" | "recordExport" | "failExport" | "markExportNotified"
  | "exportOwner" | "closeExport" | "exportFileDeleted" | "markEscalated" | "exportsDue" | "referencedExportFiles">;

export interface OwnerNotice {
  shopDomain: string;
  expiresAt: string;
}

export interface DataRequestDeps {
  repo: ExportsRepository;
  store: ExportStore;
  notifyOwner: (ownerClerkUserId: string, notice: OwnerNotice) => Promise<void>;
}

export interface MaintenanceDeps extends DataRequestDeps {
  dispatch: (requestId: string, shopDomain: string) => Promise<string | null>;
  alert: (level: 1 | 2 | 3, context: { requestId: string; shopDomain: string; dueAt: string }) => Promise<void> | void;
  now?: () => number;
}

const message = (error: unknown) => (error instanceof Error ? error.message.slice(0, 500) : "unknown");

async function notify(requestId: string, owner: string | null, notice: OwnerNotice, deps: DataRequestDeps): Promise<boolean> {
  if (!owner) {
    log.warn("Customer data export is ready but its workspace has no owner to notify", { requestId, shop: notice.shopDomain });
    return false;
  }
  try {
    await deps.notifyOwner(owner, notice);
    await deps.repo.markExportNotified(requestId);
    return true;
  } catch (error) {
    log.warn("Owner not notified of a ready customer data export; maintenance retries", { requestId, shop: notice.shopDomain }, error);
    return false;
  }
}

export interface ExportRunReport {
  outcome: string;
  counts?: Record<string, number>;
  notified?: boolean;
}

export async function runDataRequestExport(requestId: string, runId: string, deps: DataRequestDeps): Promise<ExportRunReport> {
  const claim = await deps.repo.claimExport(requestId, runId);
  if (claim.outcome !== "claimed") return { outcome: claim.outcome };

  let unrecordedFile: string | null = null;
  try {
    const customer = await deps.repo.exportCustomer(requestId, runId);
    const orders: Array<Record<string, unknown>> = [];
    for (let page = 0, after = 0; ; page++) {
      if (page >= MAX_ORDER_PAGES) throw new Error("export_too_large");
      const step = await deps.repo.exportOrders(requestId, runId, after);
      orders.push(...step.orders);
      if (step.next_after === null) break;
      after = step.next_after;
    }
    const related = await deps.repo.exportRelated(requestId, runId);
    const { json, counts } = buildExportDocument({
      requestId, shopDomain: claim.shop_domain, receivedAt: claim.received_at, dueAt: claim.due_at,
      customerId: claim.customer_id, ordersRequested: claim.order_ids, customer, orders, related,
    });
    const sealed = sealExport(json, requestId);
    unrecordedFile = exportObjectKey();
    await deps.store.put(unrecordedFile, sealed.file);
    const recorded = await deps.repo.recordExport(requestId, runId, {
      objectKey: unrecordedFile, bytes: sealed.file.length, sha256: sealed.sha256, keyVersion: sealed.keyVersion, counts,
    });
    if (recorded.outcome !== "ready" || !("expires_at" in recorded)) {
      // Withdrawn (the customer was redacted meanwhile) or taken over: this file must not remain.
      await deps.store.remove(unrecordedFile);
      log.info("Customer data export not recorded", { requestId, outcome: recorded.outcome });
      return { outcome: recorded.outcome };
    }
    unrecordedFile = null;
    const notified = await notify(requestId, recorded.owner_clerk_user_id, { shopDomain: recorded.shop_domain, expiresAt: recorded.expires_at }, deps);
    log.info("Customer data export ready", { requestId, shop: recorded.shop_domain, notified, orders: counts.orders });
    return { outcome: "ready", counts, notified };
  } catch (error) {
    if (unrecordedFile) await deps.store.remove(unrecordedFile).catch(() => {});
    await deps.repo.failExport(requestId, runId, message(error)).catch(() => {});
    throw error;
  }
}

export interface ComplianceMaintenanceReport {
  withdrawn: number;
  expired: number;
  filesDeleted: number;
  orphansDeleted: number;
  notified: number;
  dispatched: number;
  undispatched: number;
  escalated: number;
  failures: Array<{ requestId: string; action: string; error: string }>;
}

async function deleteFile(requestId: string, objectKey: string, deps: DataRequestDeps): Promise<void> {
  await deps.store.remove(objectKey);
  await deps.repo.exportFileDeleted(requestId, objectKey);
}

/** Deletes the files of closed exports (optionally one shop's only). */
async function deleteClosedFiles(deps: DataRequestDeps, report: ComplianceMaintenanceReport, shopDomain?: string): Promise<void> {
  for (const item of await deps.repo.exportsDue()) {
    if (item.action !== "delete_file" || !item.object_key || (shopDomain && item.shop_domain !== shopDomain)) continue;
    try {
      await deleteFile(item.request_id, item.object_key, deps);
      report.filesDeleted += 1;
    } catch (error) {
      report.failures.push({ requestId: item.request_id, action: item.action, error: message(error) });
    }
  }
}

const emptyReport = (): ComplianceMaintenanceReport => ({
  withdrawn: 0, expired: 0, filesDeleted: 0, orphansDeleted: 0, notified: 0, dispatched: 0, undispatched: 0, escalated: 0, failures: [],
});

export async function maintainComplianceExports(deps: MaintenanceDeps, { orphanGraceMs = 3_600_000 } = {}): Promise<ComplianceMaintenanceReport> {
  const now = deps.now ?? Date.now;
  const report = emptyReport();
  for (const item of await deps.repo.exportsDue()) {
    try {
      switch (item.action) {
        case "withdraw":
          if ((await deps.repo.closeExport(item.request_id, item.reason ?? "workspace_deleted")).outcome === "closed") report.withdrawn += 1;
          break;
        case "expire":
          if ((await deps.repo.closeExport(item.request_id, "expired")).outcome === "closed") report.expired += 1;
          break;
        case "delete_file":
          break; // Below, after this pass's withdrawals and expiries.
        case "notify": {
          const owner = await deps.repo.exportOwner(item.request_id);
          if (owner?.status === "ready" && owner.expires_at
              && (await notify(item.request_id, owner.owner_clerk_user_id, { shopDomain: owner.shop_domain, expiresAt: owner.expires_at }, deps))) {
            report.notified += 1;
          }
          break;
        }
        case "dispatch":
          if (await deps.dispatch(item.request_id, item.shop_domain)) report.dispatched += 1;
          else report.undispatched += 1;
          break;
        case "escalate":
          if (item.level) {
            await deps.alert(item.level, { requestId: item.request_id, shopDomain: item.shop_domain, dueAt: item.due_at });
            await deps.repo.markEscalated(item.request_id, item.level);
            report.escalated += 1;
          }
          break;
      }
    } catch (error) {
      report.failures.push({ requestId: item.request_id, action: item.action, error: message(error) });
    }
  }
  await deleteClosedFiles(deps, report);

  // Files no export names (a run that died between writing and recording), once older than any live run.
  const files = await deps.store.list();
  const named = await deps.repo.referencedExportFiles(files.map((file) => file.key));
  for (const file of files) {
    if (named.has(file.key) || now() - file.lastModified.getTime() < orphanGraceMs) continue;
    try {
      await deps.store.remove(file.key);
      report.orphansDeleted += 1;
    } catch (error) {
      report.failures.push({ requestId: "-", action: "delete_orphan", error: message(error) });
    }
  }
  log.info("Compliance export maintenance", { ...report, failures: report.failures.length });
  return report;
}

/**
 * Right after a redaction (customers/redact, shop/redact): withdraws the shop's
 * exports a deletion has made obsolete and deletes their files now, rather
 * than at the next hourly run. Never throws; maintenance is the backstop.
 */
export async function settleClosedExports(shopDomain: string, deps: DataRequestDeps): Promise<ComplianceMaintenanceReport> {
  const report = emptyReport();
  try {
    for (const item of await deps.repo.exportsDue()) {
      if (item.action !== "withdraw" || item.shop_domain !== shopDomain) continue;
      if ((await deps.repo.closeExport(item.request_id, item.reason ?? "shop_redacted")).outcome === "closed") report.withdrawn += 1;
    }
    await deleteClosedFiles(deps, report, shopDomain);
  } catch (error) {
    report.failures.push({ requestId: "-", action: "settle", error: message(error) });
  }
  if (report.failures.length) log.warn("Closed customer data exports not fully settled; maintenance retries", { shop: shopDomain, failures: report.failures.length });
  return report;
}
