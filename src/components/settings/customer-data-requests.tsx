import { FileDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IntegrationCard } from "./integration-card";

/** One customer data request as its workspace owner sees it (migration 0037). */
export interface CustomerDataRequestRow {
  request_id: string;
  status: "pending" | "exporting" | "ready" | "expired" | "withdrawn";
  customer_shopify_id: number | null;
  order_count: number;
  received_at: string;
  due_at: string;
  exported_at: string | null;
  expires_at: string | null;
  download_count: number;
}

const STATUS: Record<CustomerDataRequestRow["status"], { label: string; variant: "warning" | "success" | "neutral" }> = {
  pending: { label: "Preparing", variant: "warning" },
  exporting: { label: "Preparing", variant: "warning" },
  ready: { label: "Ready", variant: "success" },
  expired: { label: "Expired", variant: "neutral" },
  withdrawn: { label: "Erased", variant: "neutral" },
};

const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";

function detail(row: CustomerDataRequestRow): string {
  switch (row.status) {
    case "ready":
      return `Available until ${date(row.expires_at)}${row.download_count ? ` · downloaded ${row.download_count}×` : ""}`;
    case "expired":
      return "Deleted 30 days after it was prepared";
    case "withdrawn":
      return "Deleted: the customer's data has since been erased";
    default:
      return `Shopify's deadline: ${date(row.due_at)}`;
  }
}

/**
 * Customer data requests (Phase 2, task 9): when a customer asks Shopify for
 * their data, the export appears here for the workspace owner to download and
 * pass on. Files are kept for 30 days.
 */
export function CustomerDataRequests({ requests }: { requests: CustomerDataRequestRow[] }) {
  return (
    <IntegrationCard
      icon={<FileDown />}
      name="Customer data requests"
      accent="neutral"
      description="When a customer asks Shopify for their data, we prepare what Omni Target holds about them here. Download it and pass it to the customer; each file is kept for 30 days."
    >
      {requests.length === 0 ? (
        <p className="text-sm text-muted-foreground">No requests so far.</p>
      ) : (
        <ul className="divide-y divide-border-subtle rounded-xl border border-border-subtle">
          {requests.map((row) => {
            const status = STATUS[row.status];
            return (
              <li key={row.request_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {row.customer_shopify_id ? `Customer ${row.customer_shopify_id}` : "Customer data request"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Received {date(row.received_at)} · {detail(row)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={status.variant} size="sm">{status.label}</Badge>
                  {row.status === "ready" && (
                    <Button asChild size="sm" variant="outline">
                      <a href={`/api/compliance/exports/${row.request_id}`} download>
                        Download
                      </a>
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </IntegrationCard>
  );
}
