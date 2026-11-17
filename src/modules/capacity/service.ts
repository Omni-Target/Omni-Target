import "server-only";
import { importPreflight, quotaBytes, type ImportPreflight } from "./policy";
import { databaseSizeBytes } from "./repository";

/**
 * Import pre-flight (task 10): call before a full historical import with the
 * shop's product and order counts from Shopify. A refused import is reported
 * to the merchant and to us instead of filling the database.
 */
export async function checkImportCapacity(counts: { products: number; orders: number }): Promise<ImportPreflight> {
  return importPreflight({ currentBytes: await databaseSizeBytes(), quota: quotaBytes(), ...counts });
}
