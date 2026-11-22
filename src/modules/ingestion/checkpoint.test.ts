import { describe, expect, it } from "vitest";
import { resumableCheckpoint } from "./checkpoint";

const started = new Date("2026-11-22T12:00:00Z");

describe("resuming an import (checkpoints)", () => {
  it("resumes a checkpoint this import wrote, including after a takeover", () => {
    expect(resumableCheckpoint({ bulkOperationId: 42, committedLine: 417, updatedAt: "2026-11-22T12:05:00Z" }, started))
      .toEqual({ operationId: "gid://shopify/BulkOperation/42", line: 417 });
  });

  it("never resumes an earlier import's checkpoint, whose result would hold nothing new", () => {
    // The re-import of 2026-11-22 found the checkpoint of 2026-11-19 and imported none of the 1,500 orders.
    expect(resumableCheckpoint({ bulkOperationId: 42, committedLine: 417, updatedAt: "2026-11-19T09:55:00Z" }, started)).toBeNull();
  });

  it("starts afresh without a checkpoint, an operation or a time", () => {
    expect(resumableCheckpoint(null, started)).toBeNull();
    expect(resumableCheckpoint({ bulkOperationId: null, committedLine: 0, updatedAt: "2026-11-22T12:05:00Z" }, started)).toBeNull();
    expect(resumableCheckpoint({ bulkOperationId: 42, committedLine: 3, updatedAt: null }, started)).toBeNull();
  });
});
