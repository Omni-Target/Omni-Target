import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Keyring } from "@/platform/credentials/crypto";
import { buildExportDocument, EXPORT_PREFIX, ExportFileError, exportObjectKey, openExport, sealExport, sha256 } from "./export-file";

const keyring = (versions: Record<number, Buffer>, current: number): Keyring => ({ currentVersion: current, keys: new Map(Object.entries(versions).map(([v, k]) => [Number(v), k])) });
const v1 = randomBytes(32);
const v2 = randomBytes(32);
const request = "7f6f3a52-3a4b-4c55-9e7a-0d7b8f1c2a10";

describe("customer data export file (task 9)", () => {
  it("encrypts, records a checksum of the file, and opens only for the same request and key", () => {
    const plaintext = Buffer.from(JSON.stringify({ customer: { shopify_id: 501 } }));
    const sealed = sealExport(plaintext, request, keyring({ 1: v1 }, 1));
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.sha256).toBe(sha256(sealed.file));
    expect(sealed.file.includes(Buffer.from("501"))).toBe(false);
    expect(openExport(sealed.file, request, keyring({ 1: v1 }, 1))).toEqual(plaintext);

    expect(() => openExport(sealed.file, "00000000-0000-4000-8000-000000000000", keyring({ 1: v1 }, 1))).toThrow(ExportFileError);
    const tampered = Buffer.from(sealed.file);
    tampered[tampered.length - 1] ^= 1;
    expect(() => openExport(tampered, request, keyring({ 1: v1 }, 1))).toThrow(/authentication/);
    expect(() => openExport(Buffer.from("not an export"), request, keyring({ 1: v1 }, 1))).toThrow(/Not an export/);
  });

  it("opens a file sealed under an earlier key after rotation, and needs that key", () => {
    const sealed = sealExport(Buffer.from("{}"), request, keyring({ 1: v1 }, 1));
    expect(openExport(sealed.file, request, keyring({ 1: v1, 2: v2 }, 2))).toEqual(Buffer.from("{}"));
    expect(() => openExport(sealed.file, request, keyring({ 2: v2 }, 2))).toThrow(/version 1/);
    expect(sealExport(Buffer.from("{}"), request, keyring({ 1: v1, 2: v2 }, 2)).keyVersion).toBe(2);
  });

  it("names each attempt's file uniquely under the export prefix", () => {
    const [a, b] = [exportObjectKey(), exportObjectKey()];
    expect(a).not.toBe(b);
    expect(a).toMatch(new RegExp(`^${EXPORT_PREFIX}[0-9a-f-]{36}\\.bin$`));
  });

  it("builds the document with counts, the request, and what is deliberately absent", () => {
    const { json, counts } = buildExportDocument({
      requestId: request, shopDomain: "shop.myshopify.com", receivedAt: "2026-11-01T00:00:00Z", dueAt: "2026-12-01T00:00:00Z",
      customerId: 501, ordersRequested: [9],
      customer: { shopify_id: 501, orders_count: 2 },
      orders: [
        { shopify_id: 9, line_items: [{ shopify_id: 1 }, { shopify_id: 2 }], refunds: [{ shopify_id: 3 }], returns: [] },
        { shopify_id: 10, line_items: [{ shopify_id: 4 }], refunds: [], returns: [{ shopify_id: 5 }] },
      ],
      related: { meta_conversion_events: [{ order_id: "9" }], pending_webhook_payloads: [] },
    }, new Date("2026-11-02T00:00:00Z"));
    expect(counts).toEqual({ customer: 1, orders: 2, line_items: 3, refunds: 1, returns: 1, meta_conversion_events: 1, pending_webhook_payloads: 0 });
    const document = JSON.parse(json.toString("utf8"));
    expect(document).toMatchObject({
      format: "omnitarget.customer-data-export", version: 1, generated_at: "2026-11-02T00:00:00.000Z", shop: "shop.myshopify.com",
      request: { id: request, customer_id: 501, orders_requested: [9] }, customer: { shopify_id: 501 },
    });
    expect(document.notes.join(" ")).toMatch(/no customer names, email addresses, phone numbers or street addresses/);
  });
});
