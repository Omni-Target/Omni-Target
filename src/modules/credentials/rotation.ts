import "server-only";
import { createLogger } from "@/platform/logger";
import { supabaseAdmin } from "@/platform/supabase";
import { credentialAad, credentialKeyring, open, seal } from "@/platform/credentials/crypto";
import { sealShopCredential } from "./shopify";

/**
 * Key rotation (Phase 1, task 4): re-encrypts every credential still sealed
 * under an older key version with the current key. Each write applies only
 * over the version it read, so a concurrent refresh or reconnection wins.
 * Credentials are also re-encrypted lazily when next read. Run until nothing
 * is left, then the old key can be retired (scripts/ops/runbooks/credential-keys.md).
 */

const log = createLogger({ module: "credential-rotation" });

interface Sealed {
  ciphertext: string;
  nonce: string;
  tag: string;
}
interface ShopRow {
  shop_id: string;
  shopify_shop_id: string;
  version: number;
  key_version: number;
  access: Sealed;
  refresh: Sealed | null;
}
interface MetaRow extends Sealed {
  workspace_id: string;
  kind: "user" | "page";
  key_version: number;
  version: number;
  subject_id: string | null;
  expires_at: string | null;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) throw new Error(`${fn} failed (${error.code ?? "unknown"})`);
  return data as T;
}

export async function resealBelowCurrentKey(limit = 100): Promise<{ resealed: number; skipped: number; remaining: number }> {
  const keyring = credentialKeyring();
  const pending = await rpc<{ shop: ShopRow[]; meta: MetaRow[] }>("credentials_below_key_version", { p_version: keyring.currentVersion, p_limit: limit });
  let resealed = 0;
  let skipped = 0;

  for (const row of pending.shop) {
    const sealedOf = (part: Sealed) => ({ ...part, keyVersion: row.key_version });
    const accessToken = open(sealedOf(row.access), credentialAad.shopify(row.shopify_shop_id, "access"), keyring);
    const refreshToken = row.refresh ? open(sealedOf(row.refresh), credentialAad.shopify(row.shopify_shop_id, "refresh"), keyring) : null;
    const sealed = sealShopCredential(row.shopify_shop_id, { accessToken, refreshToken, expiresIn: null, scope: null });
    if (await rpc<boolean>("reseal_shop_credential", { p_shop: row.shop_id, p_expected_version: row.version, p_credential: sealed })) resealed++;
    else skipped++;
  }

  for (const row of pending.meta) {
    const aad = credentialAad.meta(row.workspace_id, row.kind);
    const fresh = seal(open({ ...row, keyVersion: row.key_version }, aad, keyring), aad, keyring);
    const done = await rpc<boolean>("reseal_meta_credential", {
      p_workspace: row.workspace_id,
      p_kind: row.kind,
      p_expected_version: row.version,
      p_credential: { key_version: fresh.keyVersion, ciphertext: fresh.ciphertext, nonce: fresh.nonce, tag: fresh.tag },
    });
    if (done) resealed++;
    else skipped++;
  }

  const remaining = pending.shop.length + pending.meta.length - resealed;
  log.info("Credential re-encryption pass", { keyVersion: keyring.currentVersion, resealed, skipped, remaining });
  return { resealed, skipped, remaining };
}
