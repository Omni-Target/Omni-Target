import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, enforceRateLimit, currentWorkspaceFor, shopKeyFor, economicsInputs, saveEconomicsInputs } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  enforceRateLimit: vi.fn(),
  currentWorkspaceFor: vi.fn(),
  shopKeyFor: vi.fn(),
  economicsInputs: vi.fn(),
  saveEconomicsInputs: vi.fn(),
}));
vi.mock("@/lib/api/require-user", () => ({ requireUser }));
vi.mock("@/lib/api/rate-limit", () => ({ enforceRateLimit }));
vi.mock("@/modules/workspaces/current", () => ({ currentWorkspaceFor }));
vi.mock("@/modules/ingestion/repository", () => ({ shopKeyFor }));
vi.mock("@/modules/economics/repository", () => ({ economicsInputs, saveEconomicsInputs }));

import { GET, PUT } from "./route";

/** Phase 4 finalisation: inputs for one product or one variant (a confirmed zero cost, landed cost per unit). */
const put = (changes: unknown) => PUT(new Request("http://localhost/api/economics/inputs", { method: "PUT", body: JSON.stringify({ changes }) }));

describe("/api/economics/inputs", () => {
  beforeEach(() => {
    requireUser.mockReset().mockResolvedValue({ ok: true, userId: "user-1" });
    enforceRateLimit.mockReset().mockResolvedValue({ ok: true });
    currentWorkspaceFor.mockReset().mockResolvedValue({ status: "active", shop_domain: "shop.myshopify.com" });
    shopKeyFor.mockReset().mockResolvedValue(7);
    saveEconomicsInputs.mockReset().mockResolvedValue({ saved: 1, cleared: 0 });
    economicsInputs.mockReset().mockResolvedValue({ currency: "USD", inputs: [
      { product_id: 0, variant_id: 0, key: "payment_rate", value: 0.029 },
      { product_id: 11, variant_id: 0, key: "ad_test_limit", value: 300 },
      { product_id: 11, variant_id: 22, key: "unit_cost_zero_confirmed", value: 1 },
    ] });
  });

  it("passes a product's and a variant's scope to the database, which checks they are the shop's", async () => {
    const response = await put([
      { key: "unit_cost_zero_confirmed", value: 1, state: "merchant_entered", product_id: 11, variant_id: 22 },
      { key: "landed_cost_per_unit", value: 2.5, state: "merchant_entered", product_id: 11 },
      { key: "landed_cost_per_unit", state: "cleared", product_id: 11, variant_id: 23 },
      { key: "payment_rate", value: 0.029, state: "merchant_entered" },
    ]);
    expect(response.status).toBe(200);
    expect(saveEconomicsInputs).toHaveBeenCalledWith(7, [
      { product_id: 11, variant_id: 22, key: "unit_cost_zero_confirmed", value: 1, state: "merchant_entered" },
      { product_id: 11, key: "landed_cost_per_unit", value: 2.5, state: "merchant_entered" },
      { product_id: 11, variant_id: 23, key: "landed_cost_per_unit", state: "cleared" },
      { key: "payment_rate", value: 0.029, state: "merchant_entered" },
    ], "user-1");
  });

  it("rejects a variant without its product, and ids that are not positive whole numbers", async () => {
    for (const scope of [{ variant_id: 22 }, { product_id: -1 }, { product_id: 1.5 }, { product_id: "11" }, { product_id: 11, variant_id: 0 }]) {
      const response = await put([{ key: "unit_cost_zero_confirmed", value: 1, state: "merchant_entered", ...scope }]);
      expect(response.status, JSON.stringify(scope)).toBe(400);
    }
    expect(saveEconomicsInputs).not.toHaveBeenCalled();
  });

  it("says why the database refused a change", async () => {
    saveEconomicsInputs.mockRejectedValue(new Error("economics_inputs_invalid: the product is not the shop's"));
    const response = await put([{ key: "unit_cost_zero_confirmed", value: 1, state: "merchant_entered", product_id: 99 }]);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Not saved: the product is not the shop's" });
  });

  it("reads the shop-wide inputs, or one product's own and its variants'", async () => {
    const shop = await (await GET(new Request("http://localhost/api/economics/inputs"))).json();
    expect(shop.inputs.map((i: { key: string }) => i.key)).toEqual(["payment_rate"]);
    expect(economicsInputs).toHaveBeenLastCalledWith(7, []);
    const product = await (await GET(new Request("http://localhost/api/economics/inputs?product=11"))).json();
    expect(product.inputs.map((i: { key: string }) => i.key)).toEqual(["ad_test_limit", "unit_cost_zero_confirmed"]);
    expect(economicsInputs).toHaveBeenLastCalledWith(7, [11]);
    expect((await GET(new Request("http://localhost/api/economics/inputs?product=abc"))).status).toBe(400);
  });
});
