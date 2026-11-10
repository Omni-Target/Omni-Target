import { describe, expect, it } from "vitest";
import {
  CredentialDecryptError,
  CredentialKeyError,
  credentialAad,
  generateCredentialKey,
  keyringFromEnv,
  needsReseal,
  open,
  reseal,
  seal,
} from "./crypto";

const keyA = generateCredentialKey();
const keyB = generateCredentialKey();
const v1 = keyringFromEnv({ APP_ENCRYPTION_KEY: keyA });
const aad = credentialAad.shopify(548380009, "access");

describe("credential encryption", () => {
  it("round-trips and records the key version", () => {
    const sealed = seal("shpat_example", aad, v1);
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.ciphertext).not.toContain("shpat_example");
    expect(open(sealed, aad, v1)).toBe("shpat_example");
  });

  it("uses a fresh nonce, so identical input never yields identical ciphertext", () => {
    const sealed = Array.from({ length: 50 }, () => seal("same value", aad, v1));
    expect(new Set(sealed.map((s) => s.nonce)).size).toBe(50);
    expect(new Set(sealed.map((s) => s.ciphertext + s.tag)).size).toBe(50);
  });

  it("rejects a tampered ciphertext, tag or nonce", () => {
    const sealed = seal("shpat_example", aad, v1);
    const flip = (b64: string) => {
      const bytes = Buffer.from(b64, "base64");
      bytes[0] ^= 1;
      return bytes.toString("base64");
    };
    for (const tampered of [{ ...sealed, ciphertext: flip(sealed.ciphertext) }, { ...sealed, tag: flip(sealed.tag) }, { ...sealed, nonce: flip(sealed.nonce) }]) {
      expect(() => open(tampered, aad, v1)).toThrow(CredentialDecryptError);
    }
  });

  it("refuses a ciphertext moved to another shop, workspace or credential kind", () => {
    const sealed = seal("shpat_example", aad, v1);
    for (const other of [
      credentialAad.shopify(548380010, "access"),
      credentialAad.shopify(548380009, "refresh"),
      credentialAad.meta("1b4e28ba-2fa1-41d2-883f-0016d3cca427", "user"),
    ]) {
      expect(() => open(sealed, other, v1)).toThrow(CredentialDecryptError);
    }
    const meta = seal("EAAG-token", credentialAad.meta("1b4e28ba-2fa1-41d2-883f-0016d3cca427", "user"), v1);
    expect(() => open(meta, credentialAad.meta("6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", "user"), v1)).toThrow(CredentialDecryptError);
  });

  it("refuses the wrong key", () => {
    const sealed = seal("shpat_example", aad, v1);
    expect(() => open(sealed, aad, keyringFromEnv({ APP_ENCRYPTION_KEY: keyB }))).toThrow(CredentialDecryptError);
  });
});

describe("key versions and rotation", () => {
  const v2 = keyringFromEnv({ APP_ENCRYPTION_KEY: keyB, APP_ENCRYPTION_KEY_VERSION: "2", APP_ENCRYPTION_PREVIOUS_KEYS: `1:${keyA}` });

  it("decrypts each value with the key version it records", () => {
    const old = seal("shpat_old", aad, v1);
    const fresh = seal("shpat_new", aad, v2);
    expect(fresh.keyVersion).toBe(2);
    expect(open(old, aad, v2)).toBe("shpat_old");
    expect(open(fresh, aad, v2)).toBe("shpat_new");
  });

  it("re-encrypts an old value under the current key", () => {
    const old = seal("shpat_old", aad, v1);
    expect(needsReseal(old, v2)).toBe(true);
    const rotated = reseal(old, aad, v2);
    expect(rotated.keyVersion).toBe(2);
    expect(needsReseal(rotated, v2)).toBe(false);
    expect(open(rotated, aad, keyringFromEnv({ APP_ENCRYPTION_KEY: keyB, APP_ENCRYPTION_KEY_VERSION: "2" }))).toBe("shpat_old");
  });

  it("fails loudly for a version whose key was removed", () => {
    const old = seal("shpat_old", aad, v1);
    expect(() => open(old, aad, keyringFromEnv({ APP_ENCRYPTION_KEY: keyB, APP_ENCRYPTION_KEY_VERSION: "2" }))).toThrow(CredentialDecryptError);
  });
});

describe("key configuration", () => {
  it("accepts only 256-bit base64 keys and consistent versions", () => {
    const bad: Record<string, string | undefined>[] = [
      {},
      { APP_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64") },
      { APP_ENCRYPTION_KEY: "not base64 at all!" },
      { APP_ENCRYPTION_KEY: keyA, APP_ENCRYPTION_KEY_VERSION: "0" },
      { APP_ENCRYPTION_KEY: keyA, APP_ENCRYPTION_KEY_VERSION: "2", APP_ENCRYPTION_PREVIOUS_KEYS: `3:${keyB}` },
      { APP_ENCRYPTION_KEY: keyA, APP_ENCRYPTION_KEY_VERSION: "2", APP_ENCRYPTION_PREVIOUS_KEYS: `1:${keyA}` },
      { APP_ENCRYPTION_KEY: keyA, APP_ENCRYPTION_KEY_VERSION: "2", APP_ENCRYPTION_PREVIOUS_KEYS: "garbage" },
    ];
    for (const env of bad) expect(() => keyringFromEnv(env), JSON.stringify(Object.keys(env))).toThrow(CredentialKeyError);
  });

  it("never puts key material in an error", () => {
    const secret = Buffer.alloc(16, 7).toString("base64");
    try {
      keyringFromEnv({ APP_ENCRYPTION_KEY: secret });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret);
    }
    try {
      open(seal("shpat_example", aad, v1), aad, keyringFromEnv({ APP_ENCRYPTION_KEY: keyB }));
    } catch (error) {
      expect(String((error as Error).message)).not.toMatch(new RegExp(`${keyA}|${keyB}|shpat_example`));
    }
  });
});
