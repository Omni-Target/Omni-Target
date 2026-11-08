import { describe, expect, it } from "vitest";
import { sharedSentryOptions } from "./sentry-options";
import { scrubSentryEvent, scrubText } from "./sentry-scrub";

describe("scrubText", () => {
  it.each([
    ["Shopify token", "failed with shpat_abc123DEF456"],
    ["Shopify refresh token", "shprt_abc123"],
    ["Meta token", `token EAA${"a".repeat(30)}`],
    ["Anthropic key", "key sk-ant-api03-abcDEF"],
    ["Stripe key", `sk_live_${"a".repeat(24)}`],
    ["Supabase key", "sb_secret_abcDEF123"],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl"],
    ["bearer header", "Authorization: Bearer abc.def-123"],
    ["form secret", "client_secret=abc123&grant_type=x"],
    ["email", "could not reach merchant.owner+shop@example.co.uk"],
    ["international phone", "call +234 801 234 5678 now"],
    ["US phone", "call (555) 123-4567 now"],
    ["Nigerian mobile", "call 08012345678 now"],
  ])("removes a %s", (_label, input) => {
    const output = scrubText(input);
    expect(output).toContain("[Filtered]");
    expect(output).not.toMatch(/shp[a-z]+_abc|EAAa|sk-ant-api|sk_live|sb_secret|eyJhbG|abc\.def|abc123&|merchant\.owner|801 234|123-4567|08012345678/);
  });

  it("removes URL query strings, which carry OAuth codes and shop domains", () => {
    expect(scrubText("GET https://a.test/api/cb?code=SECRET&shop=x.myshopify.com failed")).toBe(
      "GET https://a.test/api/cb?[Filtered] failed",
    );
  });

  it("removes credentials from connection strings", () => {
    expect(scrubText("connect postgres://postgres:hunter2@db.host:5432/x")).not.toContain("hunter2");
  });

  it("leaves ordinary diagnostics alone", () => {
    for (const text of [
      "Order 5551234567890 failed at 2026-11-08T12:00:00.000Z",
      "trace 4bf92f3577b34da6a3ce929d0e0e4736",
      "Shopify GraphQL HTTP 503 Service Unavailable",
      "POST /api/campaigns/generate",
    ]) {
      expect(scrubText(text)).toBe(text);
    }
  });
});

describe("scrubSentryEvent", () => {
  it("filters sensitive fields at any depth and in free text", () => {
    const event = scrubSentryEvent({
      message: "sync failed for owner@shop.example",
      extra: {
        access_token: "plain-value",
        nested: { customer: { id: 1 }, shipping_address: { city: "Lagos" }, status: "failed" },
      },
      breadcrumbs: [{ message: "GET https://x.test/a?shop=b", data: { email: "a@b.co" } }],
      user: { id: "user_1", ip_address: "1.2.3.4" },
    });
    expect(event).toEqual({
      message: "sync failed for [Filtered]",
      extra: { access_token: "[Filtered]", nested: { customer: "[Filtered]", shipping_address: "[Filtered]", status: "failed" } },
      breadcrumbs: [{ message: "GET https://x.test/a?[Filtered]", data: { email: "[Filtered]" } }],
    });
  });

  it("keeps stack traces and AI usage counters readable", () => {
    const stacktrace = { frames: [{ filename: "app:///a.js?v=1", lineno: 4 }] };
    const event = scrubSentryEvent({
      exception: { values: [{ type: "Error", value: "boom", stacktrace }] },
      data: { "gen_ai.usage.input_tokens": 120 },
    });
    expect(event.exception.values[0].stacktrace).toBe(stacktrace);
    expect(event.data["gen_ai.usage.input_tokens"]).toBe(120);
  });

  it("does not modify the original event", () => {
    const original = { message: "a@b.co" };
    scrubSentryEvent(original);
    expect(original.message).toBe("a@b.co");
  });
});

describe("shared Sentry options", () => {
  it("turns off every category of personal or request data", () => {
    expect(sharedSentryOptions.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
      genAI: { inputs: false, outputs: false },
    });
  });

  it("scrubs errors, transactions and breadcrumbs", () => {
    expect(sharedSentryOptions.beforeBreadcrumb({ message: "a@b.co" })).toEqual({ message: "[Filtered]" });
  });
});
