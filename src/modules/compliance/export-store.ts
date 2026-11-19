import "server-only";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { r2StagingStore, type StagingStore } from "@/modules/ingestion/staging";
import { EXPORT_PREFIX } from "./export-file";

/**
 * Encrypted export files in the private object bucket (the bucket that holds
 * bulk staging; R2 is the store for documents and reports, decision 7). Only
 * keys under compliance-exports/ are ever touched. The bucket has no
 * expiry rule: the maintenance task deletes each file when its export closes.
 */
export interface ExportStore {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Deletes and confirms the file is gone. */
  remove(key: string): Promise<void>;
  list(): Promise<Array<{ key: string; lastModified: Date }>>;
}

function guard(key: string): string {
  if (!key.startsWith(EXPORT_PREFIX) || key.includes("..")) throw new Error("Not an export file key");
  return key;
}

export function r2ExportStore(store: StagingStore = r2StagingStore()): ExportStore {
  const { client, bucket } = store;
  return {
    async put(key, body) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: guard(key), Body: body, ContentType: "application/octet-stream" }));
    },
    async get(key) {
      const result = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: guard(key) }))) as { Body?: AsyncIterable<Uint8Array> };
      if (!result.Body) throw new Error("Export file has no body");
      const chunks: Buffer[] = [];
      for await (const chunk of result.Body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: guard(key) }));
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404 || (error as { name?: string }).name === "NotFound") return;
        throw error;
      }
      throw new Error("Export file still present after deletion");
    },
    async list() {
      const found: Array<{ key: string; lastModified: Date }> = [];
      let token: string | undefined;
      do {
        const page = (await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: EXPORT_PREFIX, ContinuationToken: token }))) as {
          Contents?: Array<{ Key?: string; LastModified?: Date }>;
          IsTruncated?: boolean;
          NextContinuationToken?: string;
        };
        for (const object of page.Contents ?? []) if (object.Key) found.push({ key: object.Key, lastModified: object.LastModified ?? new Date(0) });
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return found;
    },
  };
}
