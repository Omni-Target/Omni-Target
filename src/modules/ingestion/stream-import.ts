/**
 * Streams one bulk result into the mirror (Phase 2, task 6): batches of whole
 * units are written, and a checkpoint is saved after each.
 *
 * Never mistaking an incomplete file for deletions: a write replaces a
 * record's children (removing those absent). Every unit except the last is
 * proved complete by the next record starting. The final batch, which holds
 * the last unit, is therefore written only once the file has ended with as
 * many records as Shopify reported for the operation. A file cut short is an
 * IncompleteResultError and that batch is not written; the import retries
 * from its checkpoint.
 */
import { batchUnits, groupUnits, parseJsonl, type JsonlRecord, type JsonlUnit } from "./jsonl";

export class IncompleteResultError extends Error {
  constructor(readonly records: number, readonly expected: number) {
    super(`Bulk result ended after ${records} of ${expected} records`);
    this.name = "IncompleteResultError";
  }
}

export interface StreamImportOptions {
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
  /** The operation's objectCount: every record in a complete file. */
  expectedObjects: number;
  maxRows: number;
  /** Resume: units ending at or before this line are already written. */
  skipThroughLine?: number;
  write: (units: JsonlUnit[]) => Promise<void>;
  checkpoint: (lastLine: number) => Promise<void>;
}

export interface StreamImportResult {
  records: number;
  units: number;
  batches: number;
  lastLine: number;
}

export async function streamImport(options: StreamImportOptions): Promise<StreamImportResult> {
  let records = 0;
  async function* counted(): AsyncGenerator<JsonlRecord> {
    for await (const record of parseJsonl(options.source)) {
      records += 1;
      yield record;
    }
  }

  const result: StreamImportResult = { records: 0, units: 0, batches: 0, lastLine: options.skipThroughLine ?? 0 };
  const commit = async (units: JsonlUnit[], lastLine: number) => {
    await options.write(units);
    await options.checkpoint(lastLine);
    result.units += units.length;
    result.batches += 1;
    result.lastLine = lastLine;
  };

  let held: { units: JsonlUnit[]; lastLine: number } | null = null;
  for await (const batch of batchUnits(groupUnits(counted()), { maxRows: options.maxRows, skipThroughLine: options.skipThroughLine ?? 0 })) {
    if (held) await commit(held.units, held.lastLine);
    held = { units: batch.units, lastLine: batch.lastLine };
  }
  result.records = records;
  if (records !== options.expectedObjects) throw new IncompleteResultError(records, options.expectedObjects);
  if (held) await commit(held.units, held.lastLine);
  return result;
}
