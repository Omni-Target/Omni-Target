import "server-only";
import { createHash } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { requireEnv } from "@/platform/env";

/**
 * Selective R2 staging of bulk results (Phase 2, task 4; decision 7).
 *
 * By default a result streams straight from Shopify's signed URL. It is
 * copied to the private JSONL bucket only when it is large or an earlier
 * attempt for the domain failed, so a retry reads from R2 instead of paying
 * for a new bulk operation. Every staged object is deleted, and the deletion
 * verified, once its import commits. A sweep removes anything older than
 * Shopify's 7-day result lifetime that a crash left behind.
 */

/** Results at least this large are staged (to be revisited with task 12's measurements). */
export const STAGE_THRESHOLD_BYTES = 256 * 1024 * 1024;
/** Multipart part size (R2: at least 5 MiB, equal except the last). */
export const PART_BYTES = 16 * 1024 * 1024;
export const STAGING_PREFIX = "bulk/";
export const STAGING_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

/** The subset of the S3 client used here, so tests can stand in for R2. */
export interface ObjectClient {
  send(command: unknown): Promise<unknown>;
}
export interface StagingStore {
  client: ObjectClient;
  bucket: string;
}

export function r2StagingStore(): StagingStore {
  const env = requireEnv(["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_JSONL_BUCKET_NAME"] as const);
  const client = new S3Client({
    region: "auto",
    endpoint: new URL(env.R2_ENDPOINT).origin,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
  return { client, bucket: env.R2_JSONL_BUCKET_NAME };
}

export function shouldStage({ fileSize, previousAttemptFailed }: { fileSize: number | null; previousAttemptFailed: boolean }): boolean {
  return previousAttemptFailed || (fileSize ?? 0) >= STAGE_THRESHOLD_BYTES;
}

/** Unguessable (the run is a random UUID) and scoped by shop, so a sweep or a shop deletion can find it. */
export function stagingKey(input: { shopKey: number; syncRunId: string; domain: string; bulkOperationId: number }): string {
  if (!/^[0-9a-f-]{36}$/.test(input.syncRunId) || !/^[a-z_]+$/.test(input.domain)) throw new Error("invalid staging key parts");
  return `${STAGING_PREFIX}${input.shopKey}/${input.syncRunId}/${input.domain}-${input.bulkOperationId}.jsonl`;
}

export interface StagedObject {
  key: string;
  bytes: number;
  sha256: string;
  parts: number;
}

/** Streams a result into R2 in fixed parts; memory holds one part. Aborts the upload on any failure. */
export async function stageStream(store: StagingStore, key: string, source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): Promise<StagedObject> {
  const created = (await store.client.send(
    new CreateMultipartUploadCommand({ Bucket: store.bucket, Key: key, ContentType: "application/x-ndjson" }),
  )) as { UploadId?: string };
  const uploadId = created.UploadId;
  if (!uploadId) throw new Error("R2 did not start the upload");

  const hash = createHash("sha256");
  const completed: Array<{ ETag?: string; PartNumber: number }> = [];
  let buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let total = 0;

  const flush = async () => {
    const body = Buffer.concat(buffered, bufferedBytes);
    buffered = [];
    bufferedBytes = 0;
    const partNumber = completed.length + 1;
    const result = (await store.client.send(
      new UploadPartCommand({ Bucket: store.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body }),
    )) as { ETag?: string };
    completed.push({ ETag: result.ETag, PartNumber: partNumber });
  };

  try {
    for await (const chunk of source as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      total += chunk.byteLength;
      let offset = 0;
      while (offset < chunk.byteLength) {
        const take = Math.min(PART_BYTES - bufferedBytes, chunk.byteLength - offset);
        buffered.push(chunk.subarray(offset, offset + take));
        bufferedBytes += take;
        offset += take;
        if (bufferedBytes === PART_BYTES) await flush();
      }
    }
    if (bufferedBytes > 0 || completed.length === 0) await flush();
    await store.client.send(
      new CompleteMultipartUploadCommand({ Bucket: store.bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: completed } }),
    );
  } catch (error) {
    await store.client.send(new AbortMultipartUploadCommand({ Bucket: store.bucket, Key: key, UploadId: uploadId })).catch(() => {});
    throw error;
  }
  return { key, bytes: total, sha256: hash.digest("hex"), parts: completed.length };
}

export async function openStaged(store: StagingStore, key: string): Promise<AsyncIterable<Uint8Array>> {
  const result = (await store.client.send(new GetObjectCommand({ Bucket: store.bucket, Key: key }))) as { Body?: AsyncIterable<Uint8Array> };
  if (!result.Body) throw new Error("staged result has no body");
  return result.Body;
}

const isNotFound = (error: unknown) => {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
};

/** Deletes a staged object and confirms it is gone. */
export async function deleteStaged(store: StagingStore, key: string): Promise<boolean> {
  await store.client.send(new DeleteObjectCommand({ Bucket: store.bucket, Key: key }));
  try {
    await store.client.send(new HeadObjectCommand({ Bucket: store.bucket, Key: key }));
    return false;
  } catch (error) {
    if (isNotFound(error)) return true;
    throw error;
  }
}

/**
 * Deletes every staged result of one shop at once (customers/redact, decision
 * 5): a temporary file may hold the redacted customer, and an import that
 * needs it again re-runs the bulk operation, whose rows then pass the
 * suppression check on write.
 */
export async function purgeShopStaging(store: StagingStore, shopKey: number): Promise<number> {
  if (!Number.isSafeInteger(shopKey) || shopKey <= 0) throw new Error("invalid shop key");
  const prefix = `${STAGING_PREFIX}${shopKey}/`;
  let token: string | undefined;
  let deleted = 0;
  do {
    const page = (await store.client.send(
      new ListObjectsV2Command({ Bucket: store.bucket, Prefix: prefix, ContinuationToken: token }),
    )) as { Contents?: Array<{ Key?: string }>; NextContinuationToken?: string; IsTruncated?: boolean };
    const keys = (page.Contents ?? []).map((object) => object.Key).filter((key): key is string => Boolean(key));
    for (let i = 0; i < keys.length; i += 1000) {
      const slice = keys.slice(i, i + 1000);
      await store.client.send(new DeleteObjectsCommand({ Bucket: store.bucket, Delete: { Objects: slice.map((Key) => ({ Key })), Quiet: true } }));
      deleted += slice.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

/** Removes staged objects older than the result lifetime; reports what remains under the prefix. */
export async function sweepStaged(store: StagingStore, now: number = Date.now(), prefix: string = STAGING_PREFIX): Promise<{ deleted: number; remaining: number }> {
  if (!prefix.startsWith(STAGING_PREFIX)) throw new Error("sweep is limited to the staging prefix");
  let token: string | undefined;
  let deleted = 0;
  let remaining = 0;
  do {
    const page = (await store.client.send(
      new ListObjectsV2Command({ Bucket: store.bucket, Prefix: prefix, ContinuationToken: token }),
    )) as { Contents?: Array<{ Key?: string; LastModified?: Date }>; NextContinuationToken?: string; IsTruncated?: boolean };
    const old = (page.Contents ?? []).filter((object) => object.Key && object.LastModified && now - object.LastModified.getTime() > STAGING_MAX_AGE_MS);
    remaining += (page.Contents ?? []).length - old.length;
    for (let i = 0; i < old.length; i += 1000) {
      const slice = old.slice(i, i + 1000);
      await store.client.send(new DeleteObjectsCommand({ Bucket: store.bucket, Delete: { Objects: slice.map((object) => ({ Key: object.Key })), Quiet: true } }));
      deleted += slice.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return { deleted, remaining };
}
