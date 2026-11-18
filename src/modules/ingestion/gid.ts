/**
 * Shopify global IDs (gid://shopify/<Type>/<id>) to the numeric IDs the
 * commerce mirror stores (bigint). Returns null for anything else, including
 * a GID of another type, so a mapper can never store the wrong kind of ID.
 */
const GID = /^gid:\/\/shopify\/([A-Za-z]+)\/(\d{1,19})(?:\?.*)?$/;

export function parseGid(value: unknown, type?: string): number | null {
  if (typeof value !== "string") return null;
  const match = GID.exec(value);
  if (!match || (type && match[1] !== type)) return null;
  const id = Number(match[2]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function gidType(value: unknown): string | null {
  return typeof value === "string" ? (GID.exec(value)?.[1] ?? null) : null;
}
