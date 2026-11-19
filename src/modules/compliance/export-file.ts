import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { credentialKeyring, type Keyring } from "@/platform/credentials/crypto";

/**
 * The customer data export file (Phase 2, task 9). Pure.
 *
 * The document is JSON: the customer's facts, their orders with lines,
 * refunds and returns, Meta send logs and webhook payloads still held about
 * them. It is encrypted at rest with AES-256-GCM under a key derived from the
 * application keyring for this purpose only, and bound to its request:
 *
 *   "OTCX1" | key version (2 bytes) | nonce (12) | tag (16) | ciphertext
 *
 * The SHA-256 of the whole file is recorded with it and checked on download.
 */
const MAGIC = Buffer.from("OTCX1", "ascii");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 2 + NONCE_BYTES + TAG_BYTES;
export const EXPORT_PREFIX = "compliance-exports/";

export class ExportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportFileError";
  }
}

/** A fresh object key for one export attempt, so a superseded run never overwrites a recorded file. */
export const exportObjectKey = () => `${EXPORT_PREFIX}${randomUUID()}.bin`;

const aad = (requestId: string) => Buffer.from(`compliance-export:${requestId}`, "utf8");

function exportKey(keyring: Keyring, version: number): Buffer {
  const base = keyring.keys.get(version);
  if (!base) throw new ExportFileError(`No encryption key for version ${version}`);
  return Buffer.from(hkdfSync("sha256", base, Buffer.alloc(0), "omnitarget/compliance-export/v1", 32));
}

export interface SealedExport {
  file: Buffer;
  keyVersion: number;
  sha256: string;
}

export function sealExport(plaintext: Buffer, requestId: string, keyring: Keyring = credentialKeyring()): SealedExport {
  const keyVersion = keyring.currentVersion;
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", exportKey(keyring, keyVersion), nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(requestId));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const version = Buffer.alloc(2);
  version.writeUInt16BE(keyVersion);
  const file = Buffer.concat([MAGIC, version, nonce, cipher.getAuthTag(), body]);
  return { file, keyVersion, sha256: sha256(file) };
}

export function openExport(file: Buffer, requestId: string, keyring: Keyring = credentialKeyring()): Buffer {
  if (file.length < HEADER_BYTES || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new ExportFileError("Not an export file");
  const version = file.readUInt16BE(MAGIC.length);
  const nonce = file.subarray(MAGIC.length + 2, MAGIC.length + 2 + NONCE_BYTES);
  const tag = file.subarray(MAGIC.length + 2 + NONCE_BYTES, HEADER_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", exportKey(keyring, version), nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad(requestId));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(file.subarray(HEADER_BYTES)), decipher.final()]);
  } catch {
    throw new ExportFileError("Export file failed authentication");
  }
}

export const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export interface ExportParts {
  requestId: string;
  shopDomain: string;
  receivedAt: string;
  dueAt: string;
  customerId: number | null;
  ordersRequested: number[];
  customer: Record<string, unknown> | null;
  orders: Array<Record<string, unknown>>;
  related: { meta_conversion_events: unknown[]; pending_webhook_payloads: unknown[] };
}

export type ExportCounts = Record<"customer" | "orders" | "line_items" | "refunds" | "returns" | "meta_conversion_events" | "pending_webhook_payloads", number>;

const length = (value: unknown) => (Array.isArray(value) ? value.length : 0);

export function buildExportDocument(parts: ExportParts, generatedAt: Date = new Date()): { json: Buffer; counts: ExportCounts } {
  const counts: ExportCounts = {
    customer: parts.customer ? 1 : 0,
    orders: parts.orders.length,
    line_items: parts.orders.reduce((n, order) => n + length(order.line_items), 0),
    refunds: parts.orders.reduce((n, order) => n + length(order.refunds), 0),
    returns: parts.orders.reduce((n, order) => n + length(order.returns), 0),
    meta_conversion_events: parts.related.meta_conversion_events.length,
    pending_webhook_payloads: parts.related.pending_webhook_payloads.length,
  };
  const document = {
    format: "omnitarget.customer-data-export",
    version: 1,
    generated_at: generatedAt.toISOString(),
    shop: parts.shopDomain,
    request: {
      id: parts.requestId, received_at: parts.receivedAt, due_at: parts.dueAt,
      customer_id: parts.customerId, orders_requested: parts.ordersRequested,
    },
    counts,
    customer: parts.customer,
    orders: parts.orders,
    meta_conversion_events: parts.related.meta_conversion_events,
    pending_webhook_payloads: parts.related.pending_webhook_payloads,
    notes: [
      "Omnitarget holds no customer names, email addresses, phone numbers or street addresses.",
      "Monthly summaries and cohort statistics are anonymous aggregates without customer identifiers, so they are not included.",
    ],
  };
  return { json: Buffer.from(JSON.stringify(document, null, 2), "utf8"), counts };
}
