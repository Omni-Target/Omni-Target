/**
 * Streaming JSONL from a bulk operation result (Phase 2, task 4).
 *
 * Bounded memory: a file of any size is read line by line, and only one
 * top-level record with its descendants (a "unit": an order and its line
 * items, a product and its variants) plus one write batch are held at once.
 *
 * Units rely on the operation running with groupObjects: true, so that every
 * child follows its parent. A child whose parent is not in the current unit
 * means that assumption failed; it raises OrphanRecordError rather than being
 * attached to the wrong record or dropped.
 *
 * Resuming: line numbers are 1-based and stable for a given result file. A
 * checkpoint records the last line of the last committed unit; a resumed
 * read skips every unit that ends at or before it.
 */

export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export class OrphanRecordError extends Error {
  constructor(readonly line: number) {
    super(`Bulk result line ${line} names a parent outside its group; the operation must run with groupObjects: true`);
    this.name = "OrphanRecordError";
  }
}

export class JsonlLineError extends Error {
  constructor(readonly line: number, reason: string) {
    super(`Bulk result line ${line}: ${reason}`);
    this.name = "JsonlLineError";
  }
}

/** Lines of a UTF-8 byte stream, without the newline. A line over the size bound is an error, never buffered. */
export async function* readLines(source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let lineNumber = 0;
  for await (const chunk of source as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      lineNumber += 1;
      yield pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
    if (pending.length > MAX_LINE_BYTES) throw new JsonlLineError(lineNumber + 1, "line exceeds the size bound");
  }
  pending += decoder.decode();
  if (pending.length) yield pending.replace(/\r$/, "");
}

export interface JsonlRecord {
  line: number;
  value: Record<string, unknown>;
}

export async function* parseJsonl(source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncGenerator<JsonlRecord> {
  let line = 0;
  for await (const text of readLines(source)) {
    line += 1;
    if (!text.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new JsonlLineError(line, "not valid JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new JsonlLineError(line, "not a JSON object");
    yield { line, value: value as Record<string, unknown> };
  }
}

export interface JsonlUnit {
  root: Record<string, unknown>;
  /** Every descendant, in file order; each carries __parentId. */
  children: Record<string, unknown>[];
  firstLine: number;
  lastLine: number;
}

/**
 * Every `id` in a record, including inline objects: a connection nested in an
 * inline list (an order's refunds and their refund line items) names the
 * inline object as its parent.
 */
function collectIds(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 6 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, into, depth + 1);
    return;
  }
  for (const [key, field] of Object.entries(value)) {
    if (key === "id" && typeof field === "string") into.add(field);
    else if (key !== "__parentId") collectIds(field, into, depth + 1);
  }
}

/** Groups each top-level record with its descendants (any depth). */
export async function* groupUnits(records: AsyncIterable<JsonlRecord>): AsyncGenerator<JsonlUnit> {
  let current: (JsonlUnit & { ids: Set<string> }) | null = null;
  for await (const { line, value } of records) {
    const parentId = value.__parentId;
    if (typeof parentId !== "string") {
      if (current) yield strip(current);
      current = { root: value, children: [], firstLine: line, lastLine: line, ids: new Set() };
      collectIds(value, current.ids);
      continue;
    }
    if (!current || !current.ids.has(parentId)) throw new OrphanRecordError(line);
    current.children.push(value);
    current.lastLine = line;
    collectIds(value, current.ids);
  }
  if (current) yield strip(current);
}

function strip(unit: JsonlUnit & { ids: Set<string> }): JsonlUnit {
  return { root: unit.root, children: unit.children, firstLine: unit.firstLine, lastLine: unit.lastLine };
}

export interface UnitBatch {
  units: JsonlUnit[];
  rows: number;
  /** The checkpoint once this batch commits: the last line of its last unit. */
  lastLine: number;
}

/**
 * Batches units by row count (a unit's root plus children), never splitting a
 * unit, and skips units already committed (lastLine <= skipThroughLine).
 * A single unit larger than maxRows forms a batch on its own.
 */
export async function* batchUnits(
  units: AsyncIterable<JsonlUnit>,
  { maxRows, skipThroughLine = 0 }: { maxRows: number; skipThroughLine?: number },
): AsyncGenerator<UnitBatch> {
  let batch: JsonlUnit[] = [];
  let rows = 0;
  for await (const unit of units) {
    if (unit.lastLine <= skipThroughLine) continue;
    const size = 1 + unit.children.length;
    if (batch.length && rows + size > maxRows) {
      yield { units: batch, rows, lastLine: batch[batch.length - 1].lastLine };
      batch = [];
      rows = 0;
    }
    batch.push(unit);
    rows += size;
  }
  if (batch.length) yield { units: batch, rows, lastLine: batch[batch.length - 1].lastLine };
}
