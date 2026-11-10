import { describe, expect, it } from "vitest";
import { readTicketParams, redactRelativeUrls, redactUrl, SENSITIVE_CALLBACK_PATHS } from "./redact-url";
import { scrubSentryEvent } from "./sentry-scrub";

describe("redactUrl (fix 8.1)", () => {
  it("removes the Clerk sign-in ticket and keeps the destination", () => {
    expect(redactUrl("/auth/shopify-callback?token=eyJabc.def.ghi&destination=%2Fdashboard")).toBe(
      "/auth/shopify-callback?token=[Filtered]&destination=%2Fdashboard",
    );
  });

  it("removes Shopify OAuth code, HMAC and state but keeps shop, host and timestamp for correlation", () => {
    expect(redactUrl("/api/auth/shopify/callback?code=abc&hmac=def&host=aG9zdA&shop=s.myshopify.com&state=xyz&timestamp=17")).toBe(
      "/api/auth/shopify/callback?code=[Filtered]&hmac=[Filtered]&host=aG9zdA&shop=s.myshopify.com&state=[Filtered]&timestamp=17",
    );
  });

  it("removes the Meta OAuth code and state", () => {
    expect(redactUrl("/api/auth/meta/callback?code=AQB123&state=nonce")).toBe("/api/auth/meta/callback?code=[Filtered]&state=[Filtered]");
  });

  it("redacts the fragment as well as the query, case-insensitively and for encoded keys", () => {
    expect(redactUrl("/x?TOKEN=a&%5F%5Fclerk_ticket=b#token=c&next=%2Fd")).toBe("/x?TOKEN=[Filtered]&%5F%5Fclerk_ticket=[Filtered]#token=[Filtered]&next=%2Fd");
  });

  it("leaves URLs without credentials unchanged", () => {
    for (const url of ["/dashboard", "/api/store/data?force=true", "/campaigns?id=42&tab=brief#top"]) {
      expect(redactUrl(url)).toBe(url);
    }
  });
});

describe("redactRelativeUrls in free text", () => {
  it("redacts a request log line and a navigation breadcrumb", () => {
    expect(redactRelativeUrls("GET /auth/shopify-callback?destination=%2Fdashboard&token=eyJsecret 200 in 12ms")).toBe(
      "GET /auth/shopify-callback?destination=%2Fdashboard&token=[Filtered] 200 in 12ms",
    );
    expect(redactRelativeUrls('navigated to "/api/auth/shopify/callback?code=c&shop=s.myshopify.com"')).toBe(
      'navigated to "/api/auth/shopify/callback?code=[Filtered]&shop=s.myshopify.com"',
    );
  });

  it("filters Sentry breadcrumbs that carry a relative callback URL", () => {
    const breadcrumb = scrubSentryEvent({ category: "navigation", data: { from: "/login", to: "/auth/shopify-callback?token=eyJsecret&destination=%2Fdashboard" } });
    expect(JSON.stringify(breadcrumb)).not.toContain("eyJsecret");
    expect(breadcrumb.data.to).toBe("/auth/shopify-callback?token=[Filtered]&destination=%2Fdashboard");
  });
});

describe("development request log", () => {
  it.each(["/auth/shopify-callback", "/api/auth/shopify/callback", "/api/auth/meta/callback", "/api/shopify/billing/callback", "/api/payments/paystack/verify"])(
    "leaves %s out of the request log",
    (path) => expect(SENSITIVE_CALLBACK_PATHS.some((pattern) => pattern.test(`${path}?x=1`))).toBe(true),
  );

  it("keeps ordinary routes in the request log", () => {
    expect(SENSITIVE_CALLBACK_PATHS.some((pattern) => pattern.test("/api/store/data?force=true"))).toBe(false);
  });
});

describe("readTicketParams", () => {
  it("reads the ticket from the fragment, never needing the query string", () => {
    expect(readTicketParams("#token=t1&destination=%2Fdashboard", "")).toEqual({ token: "t1", destination: "/dashboard" });
  });

  it("still accepts a link issued before the change", () => {
    expect(readTicketParams("", "?token=t2&destination=%2Fsettings")).toEqual({ token: "t2", destination: "/settings" });
  });
});
