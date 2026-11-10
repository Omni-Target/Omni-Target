import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Credential encryption (Phase 1, task 4). The only place that encrypts or
 * decrypts credentials.
 *
 * AES-256-GCM with a fresh 96-bit nonce per encryption and a 128-bit
 * authentication tag. Authenticated additional data binds every value to its
 * purpose and owner (see credentialAad), so a ciphertext copied to another
 * shop, workspace or credential kind fails to decrypt. Keys are versioned:
 * new values use the current key, older versions stay available for
 * decryption until re-encrypted.
 *
 *   APP_ENCRYPTION_KEY           base64 of 32 random bytes (current key)
 *   APP_ENCRYPTION_KEY_VERSION   positive integer, default 1
 *   APP_ENCRYPTION_PREVIOUS_KEYS optional "version:base64key,..." for decryption only
 *
 * Errors name variables and versions, never key material or plaintext.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedValue {
  keyVersion: number;
  ciphertext: string;
  nonce: string;
  tag: string;
}

export interface Keyring {
  currentVersion: number;
  keys: ReadonlyMap<number, Buffer>;
}

export class CredentialKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialKeyError";
  }
}

export class CredentialDecryptError extends Error {
  constructor(message = "Credential could not be decrypted") {
    super(message);
    this.name = "CredentialDecryptError";
  }
}

/** Purpose-and-owner binding for each kind of credential. */
export const credentialAad = {
  shopify: (shopifyShopId: number | string, part: "access" | "refresh") => `omnitarget/credential/v1/shopify/${shopifyShopId}/${part}`,
  meta: (workspaceId: string, kind: "user" | "page") => `omnitarget/credential/v1/meta/${workspaceId}/${kind}`,
};

function decodeKey(value: string, label: string): Buffer {
  const trimmed = value.trim();
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== KEY_BYTES || key.toString("base64").replace(/=+$/, "") !== trimmed.replace(/=+$/, "")) {
    throw new CredentialKeyError(`${label} must be ${KEY_BYTES} random bytes, base64-encoded`);
  }
  return key;
}

export function keyringFromEnv(env: Record<string, string | undefined> = process.env): Keyring {
  const raw = env.APP_ENCRYPTION_KEY;
  if (!raw) throw new CredentialKeyError("APP_ENCRYPTION_KEY is not set");
  const currentVersion = Number(env.APP_ENCRYPTION_KEY_VERSION ?? "1");
  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new CredentialKeyError("APP_ENCRYPTION_KEY_VERSION must be a positive integer");
  }
  const keys = new Map<number, Buffer>([[currentVersion, decodeKey(raw, "APP_ENCRYPTION_KEY")]]);
  for (const entry of (env.APP_ENCRYPTION_PREVIOUS_KEYS ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf(":");
    const version = Number(entry.slice(0, separator));
    if (separator < 1 || !Number.isInteger(version) || version < 1) {
      throw new CredentialKeyError("APP_ENCRYPTION_PREVIOUS_KEYS entries must look like version:base64key");
    }
    if (keys.has(version)) throw new CredentialKeyError(`Encryption key version ${version} is defined twice`);
    if (version >= currentVersion) throw new CredentialKeyError("Previous encryption key versions must be lower than the current version");
    const key = decodeKey(entry.slice(separator + 1), `Previous encryption key ${version}`);
    for (const [existingVersion, existing] of keys) {
      if (existing.equals(key)) throw new CredentialKeyError(`Encryption key versions ${existingVersion} and ${version} share the same key`);
    }
    keys.set(version, key);
  }
  return { currentVersion, keys };
}

let cached: Keyring | null = null;

export function credentialKeyring(): Keyring {
  cached ??= keyringFromEnv();
  return cached;
}

export function resetCredentialKeyringForTests(): void {
  cached = null;
}

export function seal(plaintext: string, aad: string, keyring: Keyring = credentialKeyring()): SealedValue {
  const key = keyring.keys.get(keyring.currentVersion);
  if (!key) throw new CredentialKeyError(`No key for the current version ${keyring.currentVersion}`);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    keyVersion: keyring.currentVersion,
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function open(sealed: SealedValue, aad: string, keyring: Keyring = credentialKeyring()): string {
  const key = keyring.keys.get(sealed.keyVersion);
  if (!key) throw new CredentialDecryptError(`No key for version ${sealed.keyVersion}`);
  try {
    const nonce = Buffer.from(sealed.nonce, "base64");
    const tag = Buffer.from(sealed.tag, "base64");
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new Error("malformed");
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new CredentialDecryptError();
  }
}

export const needsReseal = (sealed: Pick<SealedValue, "keyVersion">, keyring: Keyring = credentialKeyring()) =>
  sealed.keyVersion !== keyring.currentVersion;

/** Re-encrypts under the current key (rotation). */
export function reseal(sealed: SealedValue, aad: string, keyring: Keyring = credentialKeyring()): SealedValue {
  return seal(open(sealed, aad, keyring), aad, keyring);
}

/** A new key for APP_ENCRYPTION_KEY: 32 bytes from the OS CSPRNG, base64. */
export function generateCredentialKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}
