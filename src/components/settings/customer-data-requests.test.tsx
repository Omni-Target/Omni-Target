import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CustomerDataRequests, type CustomerDataRequestRow } from "./customer-data-requests";

const row = (overrides: Partial<CustomerDataRequestRow>): CustomerDataRequestRow => ({
  request_id: "7f6f3a52-3a4b-4c55-9e7a-0d7b8f1c2a10", status: "ready", customer_shopify_id: 501, order_count: 2,
  received_at: "2026-11-01T10:00:00Z", due_at: "2026-12-01T10:00:00Z", exported_at: "2026-11-01T10:05:00Z",
  expires_at: "2026-12-01T10:05:00Z", download_count: 0, ...overrides,
});

describe("customer data requests in settings (task 9)", () => {
  it("offers a download only for a ready export, until it expires", () => {
    const html = renderToStaticMarkup(<CustomerDataRequests requests={[row({})]} />);
    expect(html).toContain("Customer 501");
    expect(html).toContain('href="/api/compliance/exports/7f6f3a52-3a4b-4c55-9e7a-0d7b8f1c2a10"');
    expect(html).toContain("Available until 1 Dec 2026");
  });

  it("shows preparing, expired and erased requests without a download", () => {
    const html = renderToStaticMarkup(<CustomerDataRequests requests={[
      row({ request_id: "a", status: "pending", exported_at: null, expires_at: null }),
      row({ request_id: "b", status: "expired", customer_shopify_id: null }),
      row({ request_id: "c", status: "withdrawn", customer_shopify_id: null }),
    ]} />);
    expect(html).toContain("Shopify&#x27;s deadline: 1 Dec 2026");
    expect(html).toContain("Deleted 30 days after it was prepared");
    expect(html).toContain("Deleted: the customer&#x27;s data has since been erased");
    expect(html).not.toContain("/api/compliance/exports/");
  });

  it("says so when there are no requests", () => {
    expect(renderToStaticMarkup(<CustomerDataRequests requests={[]} />)).toContain("No requests so far.");
  });
});
