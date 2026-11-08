import { beforeEach, describe, expect, it } from "vitest";
import { clearStoreCache, readStoreCache, setStoreCacheOwner, writeStoreCache } from "./store-cache";

beforeEach(() => {
  localStorage.clear();
  clearStoreCache();
});

describe("per-user store cache (SEC-11)", () => {
  it("never shows one account's snapshot to another on the same browser", () => {
    setStoreCacheOwner("user_a");
    writeStoreCache({ store: "A" });
    setStoreCacheOwner("user_b");
    expect(readStoreCache()).toBeUndefined();
    setStoreCacheOwner("user_a");
    expect(readStoreCache()).toEqual({ store: "A" });
  });

  it("reads and writes nothing until the owner is known", () => {
    writeStoreCache({ store: "orphan" });
    expect(localStorage.length).toBe(0);
    expect(readStoreCache()).toBeUndefined();
  });

  it("does not read the old shared key", () => {
    localStorage.setItem("omni_store_data_v1", JSON.stringify({ store: "someone else" }));
    setStoreCacheOwner("user_a");
    expect(readStoreCache()).toBeUndefined();
  });

  it("removes every snapshot, and the old shared key, on sign-out", () => {
    localStorage.setItem("omni_store_data_v1", "{}");
    localStorage.setItem("omni_last_shopify_store", "kept.myshopify.com");
    setStoreCacheOwner("user_a");
    writeStoreCache({ store: "A" });
    setStoreCacheOwner("user_b");
    writeStoreCache({ store: "B" });
    clearStoreCache();
    expect(Object.keys(localStorage)).toEqual(["omni_last_shopify_store"]);
    expect(readStoreCache()).toBeUndefined();
  });
});
