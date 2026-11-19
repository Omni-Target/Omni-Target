import "server-only";
import { sendEmail } from "@/lib/email";
import { dispatchComplianceExport } from "@/modules/jobs/trigger";
import { requireEnv } from "@/platform/env";
import type { DataRequestDeps, MaintenanceDeps, OwnerNotice } from "./data-requests";
import { r2ExportStore } from "./export-store";
import * as repo from "./exports-repository";

/**
 * The workspace owner's primary email address, from Clerk's Backend API by
 * user ID (works in the app and in Trigger.dev workers alike).
 */
async function ownerEmail(clerkUserId: string): Promise<string> {
  const { CLERK_SECRET_KEY } = requireEnv(["CLERK_SECRET_KEY"] as const);
  const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`, {
    headers: { Authorization: `Bearer ${CLERK_SECRET_KEY}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Clerk user lookup failed (${response.status})`);
  const user = (await response.json()) as { primary_email_address_id?: string; email_addresses?: Array<{ id: string; email_address: string }> };
  const addresses = user.email_addresses ?? [];
  const email = (addresses.find((address) => address.id === user.primary_email_address_id) ?? addresses[0])?.email_address;
  if (!email) throw new Error("The workspace owner has no email address");
  return email;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** The owner's notice: where to download, until when. It names no customer and carries no customer data. */
export async function emailOwner(clerkUserId: string, notice: OwnerNotice): Promise<void> {
  const to = await ownerEmail(clerkUserId);
  const result = await sendEmail({
    to,
    subject: "A customer data request for your store is ready",
    html: [
      `<p>Shopify asked for the data Omni Target holds about one of your customers at ${notice.shopDomain}. It is ready.</p>`,
      `<p>Download it from <strong>Settings → Customer data requests</strong> in Omni Target before ${day(notice.expiresAt)}, and pass it to the customer as Shopify requires.</p>`,
      "<p>The file holds order details only: Omni Target keeps no customer names, email addresses, phone numbers or street addresses.</p>",
    ].join(""),
  });
  if (!result.success) {
    const reason = "error" in result && typeof result.error === "string" ? result.error : "send_failed";
    throw new Error(`Email not sent: ${reason}`);
  }
}

export function liveDataRequestDeps(): DataRequestDeps {
  return { repo, store: r2ExportStore(), notifyOwner: emailOwner };
}

export function liveMaintenanceDeps(alert: MaintenanceDeps["alert"]): MaintenanceDeps {
  return {
    ...liveDataRequestDeps(),
    alert,
    // One dispatch per request per hour at most; a live run is never doubled (the export claim decides).
    dispatch: (requestId) => dispatchComplianceExport(requestId, `maintenance-${new Date().toISOString().slice(0, 13)}`, 15_000),
  };
}
