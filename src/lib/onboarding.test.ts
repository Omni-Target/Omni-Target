import { describe, it, expect, vi, beforeEach } from "vitest";
import { getOnboardingStep } from "./onboarding";

// Mock clerkClient
const mockGetUser = vi.fn();
const mockUpdateUserMetadata = vi.fn().mockResolvedValue({});

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: vi.fn().mockResolvedValue({
    users: {
      getUser: (...args: unknown[]) => mockGetUser(...args),
      updateUserMetadata: (...args: unknown[]) => mockUpdateUserMetadata(...args),
    },
  }),
}));

// Mock @/lib/db
const mockGetUserIntegration = vi.fn();
vi.mock("@/lib/db", () => ({
  getUserIntegration: (...args: unknown[]) => mockGetUserIntegration(...args),
}));

describe("getOnboardingStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 'connect-shopify' for brand new email user with no store connected", async () => {
    mockGetUser.mockResolvedValue({
      id: "user_1",
      publicMetadata: {},
    });
    mockGetUserIntegration.mockResolvedValue(null);

    const step = await getOnboardingStep("user_1");
    expect(step).toBe("connect-shopify");
  });

  it("returns 'complete' if metadata says complete", async () => {
    mockGetUser.mockResolvedValue({
      id: "user_2",
      publicMetadata: { onboardingStep: "complete", shopifyStoreUrl: "mystore.myshopify.com" },
    });

    const step = await getOnboardingStep("user_2");
    expect(step).toBe("complete");
  });

  it("returns 'audit' if user already has shopifyStoreUrl in metadata", async () => {
    mockGetUser.mockResolvedValue({
      id: "user_3",
      publicMetadata: { shopifyStoreUrl: "mystore.myshopify.com" },
    });

    const step = await getOnboardingStep("user_3");
    expect(step).toBe("audit");
  });

  it("returns 'audit' if metadata has legacy connect-meta or audit step", async () => {
    mockGetUser.mockResolvedValue({
      id: "user_4",
      publicMetadata: { onboardingStep: "audit" },
    });

    const step = await getOnboardingStep("user_4");
    expect(step).toBe("audit");
  });

  it("returns 'audit' if store is found in database integration even if metadata was unset", async () => {
    mockGetUser.mockResolvedValue({
      id: "user_5",
      publicMetadata: {},
    });
    mockGetUserIntegration.mockResolvedValue({
      shopify_store_url: "mystore.myshopify.com",
      shopify_access_token: "shpat_xxx",
    });

    const step = await getOnboardingStep("user_5");
    expect(step).toBe("audit");
  });
});
