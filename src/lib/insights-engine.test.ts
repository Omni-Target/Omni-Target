import { expect, it, vi } from "vitest";
import type { StoreData } from "./store-data";

const createMessage = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMessage };
  },
}));
vi.mock("@/lib/db", () => ({ logApiUsage: vi.fn() }));

import { generateCreativeHooksOnly, generateTargetingProfile } from "./insights-engine";

it("auto-recovers verified creative hooks when first-pass hooks are missing or rejected by validator", async () => {
  const product: StoreData["products"][number] = {
    id: "pants-1",
    name: "Ego Pants (Noir)",
    revenue: 30000,
    units_sold: 3,
    in_stock: true,
    price: 10000,
    collection: "Pants",
    image_url: "",
    should_advertise: true,
    description: "Wide-leg linen pants with hand-beaded cowrie details.",
    tags: ["linen"],
    product_type: "Pants",
    has_partial_stock: false,
    in_stock_variant_count: 1,
    total_variant_count: 1,
  };
  const store = {
    store: { name: "KASA", domain: "example.com", currency: "NGN", country: "Nigeria", platform: "shopify" },
    orders: {
      total_revenue: 30000, order_count: 3, average_order_value: 10000,
      top_locations: [{ city: "Lagos", country: "Nigeria", percentage: 100 }],
      peak_days: ["Friday"], peak_hours: [], repeat_customer_rate: 0,
      revenue_last_30_days: 30000, orders_last_30_days: 3,
    },
    products: [product],
    customers: { total_count: 3, new_count: 3, returning_count: 0 },
    generated_at: "2026-09-26T00:00:00.000Z",
  } as StoreData;

  // First call (Advantage+ unified profile) returns empty hooks
  // Second call (auto-recovery via generateCreativeHooksOnly) returns 3 verified hooks
  createMessage
    .mockReset()
    .mockResolvedValueOnce({
      usage: { input_tokens: 100, output_tokens: 30 },
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tool-1", input: {
        target_product_title: product.name,
        creative_hooks: [],
      } }],
    })
    .mockResolvedValueOnce({
      usage: { input_tokens: 45, output_tokens: 110 },
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tool-2", input: {
        target_product_title: product.name,
        creative_hooks: [
          {
            angle: "Problem / Friction",
            visual_cue: "Open on the wide-leg cut in motion.",
            on_screen_text: "Room in every step.",
            primary_text_hook: "See how the wide-leg cut moves on Ego Pants (Noir).",
          },
          {
            angle: "Material / Craftsmanship",
            visual_cue: "Macro shot of the hand-beaded cowrie details.",
            on_screen_text: "Hand-beaded cowrie details.",
            primary_text_hook: "A closer view of the hand-beaded cowrie details.",
          },
          {
            angle: "Identity / Status",
            visual_cue: "Style the pants with two different tops.",
            on_screen_text: "One pair. Two looks.",
            primary_text_hook: "Build a look around Ego Pants (Noir).",
          },
        ],
      } }],
    });

  const profile = await generateTargetingProfile(store, 1, 50, null, product);

  // Both calls occurred seamlessly without requiring manual user retry
  expect(createMessage).toHaveBeenCalledTimes(2);
  expect(profile.creative_hooks).toHaveLength(3);
  expect(profile.creative_hooks_status).toBe("generated");
  expect(profile.creative_hooks[0].angle).toBe("Problem / Friction");
});

it("falls back gracefully when both initial pass and auto-recovery fail validation", async () => {
  const product: StoreData["products"][number] = {
    id: "pants-1",
    name: "Ego Pants (Noir)",
    revenue: 30000,
    units_sold: 3,
    in_stock: true,
    price: 10000,
    collection: "Pants",
    image_url: "",
    should_advertise: true,
    description: "Wide-leg linen pants with hand-beaded cowrie details.",
    tags: ["linen"],
    product_type: "Pants",
    has_partial_stock: false,
    in_stock_variant_count: 1,
    total_variant_count: 1,
  };
  const store = {
    store: { name: "KASA", domain: "example.com", currency: "NGN", country: "Nigeria", platform: "shopify" },
    orders: {
      total_revenue: 30000, order_count: 3, average_order_value: 10000,
      top_locations: [{ city: "Lagos", country: "Nigeria", percentage: 100 }],
      peak_days: ["Friday"], peak_hours: [], repeat_customer_rate: 0,
      revenue_last_30_days: 30000, orders_last_30_days: 3,
    },
    products: [product],
    customers: { total_count: 3, new_count: 3, returning_count: 0 },
    generated_at: "2026-09-26T00:00:00.000Z",
  } as StoreData;

  // Both calls return invalid/empty hooks
  createMessage.mockReset().mockResolvedValue({
    usage: { input_tokens: 100, output_tokens: 30 },
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "tool-fail", input: {
      target_product_title: product.name,
      creative_hooks: [],
    } }],
  });

  const profile = await generateTargetingProfile(store, 1, 50, null, product);

  expect(createMessage).toHaveBeenCalledTimes(2);
  expect(profile.generation_status).toBe("fallback");
  expect(profile.creative_hooks_status).toBe("fallback");
  expect(profile.creative_hooks).toEqual([]);
});

it("generateCreativeHooksOnly standalone recovery succeeds and uses generate_product_hooks tool", async () => {
  const product: StoreData["products"][number] = {
    id: "pants-1",
    name: "Ego Pants (Noir)",
    revenue: 30000,
    units_sold: 3,
    in_stock: true,
    price: 10000,
    collection: "Pants",
    image_url: "",
    should_advertise: true,
    description: "Wide-leg linen pants with hand-beaded cowrie details.",
    tags: ["linen"],
    product_type: "Pants",
    has_partial_stock: false,
    in_stock_variant_count: 1,
    total_variant_count: 1,
  };
  const store = {
    store: { name: "KASA", domain: "example.com", currency: "NGN", country: "Nigeria", platform: "shopify" },
    orders: {
      total_revenue: 30000, order_count: 3, average_order_value: 10000,
      top_locations: [{ city: "Lagos", country: "Nigeria", percentage: 100 }],
      peak_days: ["Friday"], peak_hours: [], repeat_customer_rate: 0,
      revenue_last_30_days: 30000, orders_last_30_days: 3,
    },
    products: [product],
    customers: { total_count: 3, new_count: 3, returning_count: 0 },
    generated_at: "2026-09-26T00:00:00.000Z",
  } as StoreData;

  createMessage.mockReset().mockResolvedValue({
    usage: { input_tokens: 45, output_tokens: 110 },
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "tool-2", input: {
      target_product_title: product.name,
      creative_hooks: [
        {
          angle: "Problem / Friction",
          visual_cue: "Open on the wide-leg cut in motion.",
          on_screen_text: "Room in every step.",
          primary_text_hook: "See how the wide-leg cut moves on Ego Pants (Noir).",
        },
        {
          angle: "Material / Craftsmanship",
          visual_cue: "Macro shot of the hand-beaded cowrie details.",
          on_screen_text: "Hand-beaded cowrie details.",
          primary_text_hook: "A closer view of the hand-beaded cowrie details.",
        },
        {
          angle: "Identity / Status",
          visual_cue: "Style the pants with two different tops.",
          on_screen_text: "One pair. Two looks.",
          primary_text_hook: "Build a look around Ego Pants (Noir).",
        },
      ],
    } }],
  });

  const recoveredHooks = await generateCreativeHooksOnly(store, product);
  expect(recoveredHooks).toHaveLength(3);
  expect(createMessage).toHaveBeenCalledTimes(1);
  expect(createMessage.mock.calls[0][0]).toMatchObject({
    max_tokens: 1200,
    tool_choice: { name: "generate_product_hooks" },
  });
});
