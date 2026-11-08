import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createOAuthState,
  createPendingInstall,
  isFreshShopifyTimestamp,
  isValidShopDomain,
  normalizeFrom,
  normalizePlan,
  readCookie,
  readOAuthState,
  readPendingInstall,
  resolveCallbackDecision,
  verifyShopifyQueryHmac,
} from "./shopify-oauth";

const SECRET = "test-shopify-client-secret";

function signQuery(params: Record<string, string>, secret = SECRET): URLSearchParams {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const hmac = createHmac("sha256", secret).update(message).digest("hex");
  return new URLSearchParams({ ...params, hmac });
}

beforeEach(() => {
  process.env.SHOPIFY_CLIENT_SECRET = SECRET;
});

describe("verifyShopifyQueryHmac", () => {
  const params = { code: "abc", shop: "store.myshopify.com", state: "nonce", timestamp: "1762560000" };

  it("accepts a correctly signed callback", () => {
    expect(verifyShopifyQueryHmac(signQuery(params), SECRET)).toBe(true);
  });

  it("rejects any tampered parameter", () => {
    const signed = signQuery(params);
    signed.set("state", "x___signup___user_victim___");
    expect(verifyShopifyQueryHmac(signed, SECRET)).toBe(false);
  });

  it("rejects a signature made with another secret, a missing hmac and malformed hmacs", () => {
    expect(verifyShopifyQueryHmac(signQuery(params, "other"), SECRET)).toBe(false);
    expect(verifyShopifyQueryHmac(new URLSearchParams(params), SECRET)).toBe(false);
    const short = signQuery(params);
    short.set("hmac", "abc");
    expect(verifyShopifyQueryHmac(short, SECRET)).toBe(false);
    expect(verifyShopifyQueryHmac(signQuery(params), undefined)).toBe(false);
  });
});

describe("shop / timestamp / input validation", () => {
  it.each([
    ["store.myshopify.com", true],
    ["my-store-2.myshopify.com", true],
    ["Store.myshopify.com", false],
    ["store.myshopify.com.evil.com", false],
    ["evil.com", false],
    ["-store.myshopify.com", false],
    ["store.myshopify.com/admin", false],
    ["", false],
  ])("isValidShopDomain(%s) === %s", (shop, expected) => {
    expect(isValidShopDomain(shop)).toBe(expected);
  });

  it("only accepts recent Shopify timestamps", () => {
    const now = Date.UTC(2026, 10, 8, 1, 0, 0);
    const seconds = (offset: number) => String(Math.floor(now / 1000) + offset);
    expect(isFreshShopifyTimestamp(seconds(0), now)).toBe(true);
    expect(isFreshShopifyTimestamp(seconds(-14 * 60), now)).toBe(true);
    expect(isFreshShopifyTimestamp(seconds(-16 * 60), now)).toBe(false);
    expect(isFreshShopifyTimestamp(seconds(4 * 60), now)).toBe(true);
    expect(isFreshShopifyTimestamp(seconds(6 * 60), now)).toBe(false);
    expect(isFreshShopifyTimestamp("not-a-number", now)).toBe(false);
    expect(isFreshShopifyTimestamp(null, now)).toBe(false);
  });

  it("normalizes untrusted `from` and `plan` inputs", () => {
    expect(normalizeFrom("dashboard", true)).toBe("dashboard");
    expect(normalizeFrom("signup___user_victim", false)).toBe("signup");
    expect(normalizeFrom(null, true)).toBe("onboarding");
    expect(normalizePlan("GROWTH")).toBe("growth");
    expect(normalizePlan("enterprise")).toBe("");
  });

  it("reads a named cookie from a Cookie header", () => {
    expect(readCookie("a=1; shopify_oauth_state=abc.def; b=2", "shopify_oauth_state")).toBe("abc.def");
    expect(readCookie("a=1", "shopify_oauth_state")).toBeNull();
    expect(readCookie(null, "x")).toBeNull();
  });
});

describe("signed OAuth state cookie", () => {
  const input = { shop: "store.myshopify.com", from: "signup" as const, plan: "" as const, initiatorUserId: null };

  it("round-trips and binds the nonce", () => {
    const { nonce, cookieValue } = createOAuthState(input);
    const payload = readOAuthState(cookieValue);
    expect(payload?.n).toBe(nonce);
    expect(payload?.shop).toBe("store.myshopify.com");
    expect(payload?.uid).toBeNull();
  });

  it("rejects tampered, foreign-key, expired and cross-purpose cookies", () => {
    const { cookieValue } = createOAuthState(input);
    const [body, mac] = cookieValue.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), uid: "user_victim" }),
    ).toString("base64url");
    expect(readOAuthState(`${forgedBody}.${mac}`)).toBeNull();

    process.env.SHOPIFY_CLIENT_SECRET = "rotated-secret";
    expect(readOAuthState(cookieValue)).toBeNull();
    process.env.SHOPIFY_CLIENT_SECRET = SECRET;

    const now = Date.now();
    const old = createOAuthState(input, now - 11 * 60 * 1000);
    expect(readOAuthState(old.cookieValue, now)).toBeNull();

    // A pending-install cookie must never be accepted as OAuth state (and vice versa).
    const pending = createPendingInstall({ shop: input.shop, from: "app_store", plan: "" });
    expect(readOAuthState(pending)).toBeNull();
    expect(readPendingInstall(cookieValue)).toBeNull();
    expect(readPendingInstall(pending)?.shop).toBe("store.myshopify.com");
  });

  it("refuses to mint state for a non-myshopify host", () => {
    expect(() => createOAuthState({ ...input, shop: "evil.com" })).toThrow();
  });
});

describe("resolveCallbackDecision (SEC-01 account selection)", () => {
  const shop = "attacker-store.myshopify.com";
  const signedOutState = () => {
    const { nonce, cookieValue } = createOAuthState({ shop, from: "signup", plan: "", initiatorUserId: null });
    return { nonce, payload: readOAuthState(cookieValue)! };
  };

  it("rejects the original takeover: a forged state naming the victim, with no state cookie", () => {
    const decision = resolveCallbackDecision({
      sessionUserId: null,
      statePayload: null,
      stateParam: "deadbeef___signup___user_victim___",
      shop,
      linkedUserIds: [],
    });
    expect(decision).toEqual({ kind: "reject", reason: "invalid_state" });
  });

  it("rejects a state that does not match this browser's cookie or this shop", () => {
    const { payload } = signedOutState();
    expect(
      resolveCallbackDecision({ sessionUserId: null, statePayload: payload, stateParam: "0".repeat(64), shop, linkedUserIds: [] }),
    ).toEqual({ kind: "reject", reason: "invalid_state" });
    expect(
      resolveCallbackDecision({
        sessionUserId: null,
        statePayload: payload,
        stateParam: payload.n,
        shop: "other.myshopify.com",
        linkedUserIds: [],
      }),
    ).toEqual({ kind: "reject", reason: "invalid_state" });
  });

  it("rejects a flow whose session changed between connect and callback", () => {
    const { nonce, cookieValue } = createOAuthState({ shop, from: "onboarding", plan: "", initiatorUserId: "user_a" });
    const decision = resolveCallbackDecision({
      sessionUserId: "user_b",
      statePayload: readOAuthState(cookieValue),
      stateParam: nonce,
      shop,
      linkedUserIds: [],
    });
    expect(decision).toEqual({ kind: "reject", reason: "session_mismatch" });
  });

  it("links only to the browser's own authenticated session", () => {
    const { nonce, cookieValue } = createOAuthState({ shop, from: "onboarding", plan: "", initiatorUserId: "user_a" });
    expect(
      resolveCallbackDecision({
        sessionUserId: "user_a",
        statePayload: readOAuthState(cookieValue),
        stateParam: nonce,
        shop,
        linkedUserIds: ["user_other"],
      }),
    ).toEqual({ kind: "link_to_session", userId: "user_a" });
  });

  it("signed out + store linked to exactly one account => sign in that account only", () => {
    const { nonce, payload } = signedOutState();
    expect(
      resolveCallbackDecision({ sessionUserId: null, statePayload: payload, stateParam: nonce, shop, linkedUserIds: ["user_a", "user_a"] }),
    ).toEqual({ kind: "sign_in_linked_user", userId: "user_a" });
  });

  it("signed out + unlinked store => pending install (no email linking, no account creation)", () => {
    const { nonce, payload } = signedOutState();
    expect(
      resolveCallbackDecision({ sessionUserId: null, statePayload: payload, stateParam: nonce, shop, linkedUserIds: [] }),
    ).toEqual({ kind: "pending_install", reason: "no_linked_account" });
  });

  it("signed out + store linked to several accounts => pending install, never an arbitrary account", () => {
    const { nonce, payload } = signedOutState();
    expect(
      resolveCallbackDecision({ sessionUserId: null, statePayload: payload, stateParam: nonce, shop, linkedUserIds: ["user_a", "user_b"] }),
    ).toEqual({ kind: "pending_install", reason: "ambiguous_linked_accounts" });
  });
});
