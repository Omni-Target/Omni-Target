import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deleteStaged,
  purgeShopStaging,
  PART_BYTES,
  shouldStage,
  STAGE_THRESHOLD_BYTES,
  STAGING_MAX_AGE_MS,
  stageStream,
  stagingKey,
  sweepStaged,
  type StagingStore,
} from "./staging";

/** A stand-in for R2 that records each command by name. */
function fakeStore(handlers: Record<string, (input: Record<string, unknown>) => unknown> = {}) {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const store: StagingStore = {
    bucket: "jsonl",
    client: {
      async send(command: unknown) {
        const name = (command as { constructor: { name: string } }).constructor.name;
        const input = (command as { input: Record<string, unknown> }).input;
        sent.push({ name, input });
        const handler = handlers[name];
        if (handler) return handler(input);
        if (name === "CreateMultipartUploadCommand") return { UploadId: "upload-1" };
        if (name === "UploadPartCommand") return { ETag: `etag-${input.PartNumber}` };
        return {};
      },
    },
  };
  return { store, sent };
}

async function* bytes(total: number, chunk: number): AsyncGenerator<Uint8Array> {
  for (let sent = 0; sent < total; sent += chunk) yield new Uint8Array(Math.min(chunk, total - sent)).fill(sent % 251);
}

describe("selective staging (decision 7)", () => {
  it("stages only large results, or after a failed attempt", () => {
    expect(shouldStage({ fileSize: STAGE_THRESHOLD_BYTES, previousAttemptFailed: false })).toBe(true);
    expect(shouldStage({ fileSize: STAGE_THRESHOLD_BYTES - 1, previousAttemptFailed: false })).toBe(false);
    expect(shouldStage({ fileSize: null, previousAttemptFailed: true })).toBe(true);
  });

  it("uses unguessable keys under the staging prefix", () => {
    const run = "9f1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
    expect(stagingKey({ shopKey: 7, syncRunId: run, domain: "orders", bulkOperationId: 77 })).toBe(`bulk/7/${run}/orders-77.jsonl`);
    expect(() => stagingKey({ shopKey: 7, syncRunId: "../../etc", domain: "orders", bulkOperationId: 1 })).toThrow();
  });
});

describe("streaming a result into R2", () => {
  it("uploads fixed-size parts holding one part in memory, with a checksum of everything sent", async () => {
    const { store, sent } = fakeStore();
    const total = 2 * PART_BYTES + 1234;
    const expected = createHash("sha256");
    for await (const chunk of bytes(total, 3_000_000)) expected.update(chunk);

    const staged = await stageStream(store, "bulk/1/x/orders-1.jsonl", bytes(total, 3_000_000));
    expect(staged).toEqual({ key: "bulk/1/x/orders-1.jsonl", bytes: total, sha256: expected.digest("hex"), parts: 3 });
    const parts = sent.filter((c) => c.name === "UploadPartCommand").map((c) => (c.input.Body as Buffer).byteLength);
    expect(parts).toEqual([PART_BYTES, PART_BYTES, 1234]);
    expect(sent.at(-1)).toMatchObject({ name: "CompleteMultipartUploadCommand", input: { MultipartUpload: { Parts: [
      { ETag: "etag-1", PartNumber: 1 }, { ETag: "etag-2", PartNumber: 2 }, { ETag: "etag-3", PartNumber: 3 },
    ] } } });
  });

  it("aborts the upload when a part fails, leaving nothing behind", async () => {
    const { store, sent } = fakeStore({ UploadPartCommand: () => { throw new Error("network"); } });
    await expect(stageStream(store, "bulk/1/x/orders-1.jsonl", bytes(10, 10))).rejects.toThrow("network");
    expect(sent.map((c) => c.name)).toEqual(["CreateMultipartUploadCommand", "UploadPartCommand", "AbortMultipartUploadCommand"]);
  });
});

describe("purging a shop's staging on customers/redact (decision 5)", () => {
  it("deletes every staged object under the shop's prefix and nothing else", async () => {
    const { store, sent } = fakeStore({ ListObjectsV2Command: (input) => ({
      Contents: input.Prefix === "bulk/7/" ? [{ Key: "bulk/7/run/orders-1.jsonl" }, { Key: "bulk/7/run/customers-2.jsonl" }] : [], IsTruncated: false,
    }) });
    expect(await purgeShopStaging(store, 7)).toBe(2);
    expect(sent.find((c) => c.name === "ListObjectsV2Command")?.input.Prefix).toBe("bulk/7/");
    await expect(purgeShopStaging(store, 0)).rejects.toThrow();
  });
});

describe("verified cleanup", () => {
  it("confirms a deletion only when the object is gone", async () => {
    const gone = fakeStore({ HeadObjectCommand: () => { throw Object.assign(new Error("not found"), { name: "NotFound" }); } });
    expect(await deleteStaged(gone.store, "bulk/1/x/a.jsonl")).toBe(true);
    const still = fakeStore();
    expect(await deleteStaged(still.store, "bulk/1/x/a.jsonl")).toBe(false);
  });

  it("sweeps objects older than the result lifetime across pages, and reports what remains", async () => {
    const now = Date.parse("2026-11-18T12:00:00Z");
    const old = new Date(now - STAGING_MAX_AGE_MS - 1);
    const fresh = new Date(now - 60_000);
    const pages = [
      { Contents: [{ Key: "bulk/1/a", LastModified: old }, { Key: "bulk/1/b", LastModified: fresh }], IsTruncated: true, NextContinuationToken: "t2" },
      { Contents: [{ Key: "bulk/2/c", LastModified: old }], IsTruncated: false },
    ];
    const { store, sent } = fakeStore({ ListObjectsV2Command: (input) => (input.ContinuationToken ? pages[1] : pages[0]) });
    expect(await sweepStaged(store, now)).toEqual({ deleted: 2, remaining: 1 });
    const deletedKeys = sent.filter((c) => c.name === "DeleteObjectsCommand").flatMap((c) => (c.input.Delete as { Objects: Array<{ Key: string }> }).Objects.map((o) => o.Key));
    expect(deletedKeys).toEqual(["bulk/1/a", "bulk/2/c"]);
    await expect(sweepStaged(store, now, "backups/")).rejects.toThrow(/staging prefix/);
  });
});
