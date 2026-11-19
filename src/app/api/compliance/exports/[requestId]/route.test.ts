import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateCredentialKey, resetCredentialKeyringForTests } from "@/platform/credentials/crypto";
import { sealExport } from "@/modules/compliance/export-file";

const h = vi.hoisted(() => ({
  user: vi.fn<() => Promise<string | null>>(),
  authorize: vi.fn(),
  get: vi.fn(),
  capture: vi.fn(),
}));
vi.mock("@/modules/workspaces/http", async () => {
  const { NextResponse } = await import("next/server");
  return {
    signedInUser: h.user,
    unauthorized: () => NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    notFound: () => NextResponse.json({ error: "not_found" }, { status: 404 }),
  };
});
vi.mock("@/modules/compliance/exports-repository", () => ({ authorizeDownload: h.authorize }));
vi.mock("@/modules/compliance/export-store", () => ({ r2ExportStore: () => ({ get: h.get }) }));
vi.mock("@/lib/observability/capture", () => ({ captureBackgroundFailure: h.capture }));

import { GET } from "./route";

const REQUEST = "7f6f3a52-3a4b-4c55-9e7a-0d7b8f1c2a10";
const download = (id = REQUEST) => GET(new Request(`http://localhost/api/compliance/exports/${id}`), { params: Promise.resolve({ requestId: id }) });

beforeEach(() => {
  vi.stubEnv("APP_ENCRYPTION_KEY", generateCredentialKey());
  vi.stubEnv("APP_ENCRYPTION_KEY_VERSION", "1");
  resetCredentialKeyringForTests();
  for (const fn of Object.values(h)) fn.mockReset();
  h.user.mockResolvedValue("user_owner");
});

describe("customer data export download (task 9)", () => {
  it("gives the owner the decrypted file, as an attachment that is never cached", async () => {
    const sealed = sealExport(Buffer.from('{"customer":{"shopify_id":501}}'), REQUEST);
    h.authorize.mockResolvedValue({ outcome: "authorized", object_key: "compliance-exports/x.bin", sha256: sealed.sha256, key_version: 1, bytes: sealed.file.length, customer_id: 501, shop_domain: "s.myshopify.com" });
    h.get.mockResolvedValue(sealed.file);
    const response = await download();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"customer":{"shopify_id":501}}');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="customer-data-501-7f6f3a52.json"');
    expect(h.authorize).toHaveBeenCalledWith(REQUEST, "user_owner");
  });

  it("answers 401 without a session, and 404 to anyone else or for a malformed id", async () => {
    h.user.mockResolvedValueOnce(null);
    expect((await download()).status).toBe(401);
    h.authorize.mockResolvedValue({ outcome: "not_found" });
    expect((await download()).status).toBe(404);
    expect((await download("not-a-uuid")).status).toBe(404);
    expect(h.get).not.toHaveBeenCalled();
  });

  it("refuses a file that does not match its recorded checksum", async () => {
    const sealed = sealExport(Buffer.from("{}"), REQUEST);
    h.authorize.mockResolvedValue({ outcome: "authorized", object_key: "compliance-exports/x.bin", sha256: "0".repeat(64), key_version: 1, bytes: 2, customer_id: 501, shop_domain: "s.myshopify.com" });
    h.get.mockResolvedValue(sealed.file);
    const response = await download();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("{}");
    expect(h.capture).toHaveBeenCalledWith("compliance-export-download", expect.any(Error));
  });
});
