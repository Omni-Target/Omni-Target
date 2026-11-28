/**
 * Live economics check (Phase 4, task 9). Opt-in; staging only. Runs and records the engine for a shop's real
 * products and checks, on real data:
 *  - every recorded recommendation recomputes identically from the inputs stored with it;
 *  - the safeguards hold: blocked and unviable at exactly zero, missing data with no amounts, no budget above any
 *    ceiling, target ≤ maximum viable ≤ break-even, and the portfolio within the monthly limit;
 *  - the top product's contribution equals a hand calculation from its evidence;
 *  - (LIVE_CAMPAIGN=1) a tracked campaign's results flow into acquisition evidence and feedback.
 *
 * With LIVE_SYNTHETIC_INPUTS=1 it first writes LABELLED SYNTHETIC merchant inputs (costs and limits, entered by
 * "phase4-verification-synthetic") so the engine has something to work with on a test store; the campaign it
 * creates is named as synthetic and ended afterwards. Nothing is published or spent. Writes LIVE_OUT.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
const BY = "phase4-verification-synthetic";

describe("live economics engine", () => {
  it("records reproducible recommendations that keep every safeguard on real data", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");
    const { syncShop } = await import("@/modules/ingestion/sync-repository");
    const { supabaseAdmin } = await import("@/platform/supabase");
    const repo = await import("./repository");
    const { runAndRecordEconomics, evaluateShopCampaigns } = await import("./service");
    const { recommendProduct } = await import("./recommend");
    const shop = await syncShop(domain);
    if (!shop) throw new Error("shop not ingestible");
    const key = shop.shopKey;

    if (process.env.LIVE_SYNTHETIC_INPUTS === "1") {
      // Illustrative merchant inputs for a test store, in the shop's currency (NGN on omni-beta).
      await repo.saveEconomicsInputs(key, [
        { key: "payment_rate", value: 0.015, state: "merchant_entered" }, { key: "payment_fixed_fee", value: 100, state: "merchant_entered" },
        { key: "selling_fee_rate", value: 0, state: "confirmed_none" }, { key: "shipping_cost_per_order", value: 2500, state: "merchant_entered" },
        { key: "fulfilment_cost_per_order", value: 500, state: "merchant_entered" }, { key: "fulfilment_cost_per_unit", value: 0, state: "confirmed_none" },
        { key: "landed_cost_rate", value: 0, state: "confirmed_none" }, { key: "return_handling_cost", value: 1500, state: "merchant_entered" },
        // Limits proportionate to this catalog (orders of about ₦300,000): a 5-sale minimum test needs over ₦600,000.
        { key: "ad_monthly_limit", value: 20_000_000, state: "merchant_entered" }, { key: "ad_test_limit", value: 3_000_000, state: "merchant_entered" },
        { key: "ad_daily_limit", value: 300_000, state: "merchant_entered" }, { key: "ad_max_loss", value: 2_000_000, state: "merchant_entered" },
      ], BY);
    }

    // The products: the 25 with most paid orders in the last year, and 2 never sold.
    const since = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const { data: recent } = await supabaseAdmin.from("orders").select("shopify_id").eq("shop_key", key).gte("processed_at", since).limit(5000);
    const orderIds = (recent ?? []).map((o) => o.shopify_id);
    const counts = new Map<number, number>();
    for (let i = 0; i < orderIds.length; i += 300) {
      const { data: lines } = await supabaseAdmin.from("order_line_items").select("product_shopify_id").eq("shop_key", key).in("order_shopify_id", orderIds.slice(i, i + 300));
      for (const l of lines ?? []) if (l.product_shopify_id !== null) counts.set(Number(l.product_shopify_id), (counts.get(Number(l.product_shopify_id)) ?? 0) + 1);
    }
    const sold = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id).slice(0, 25);
    const { data: unsold } = await supabaseAdmin.from("products").select("shopify_id").eq("shop_key", key).not("shopify_id", "in", `(${sold.join(",") || 0})`).limit(2);
    const ids = [...sold, ...(unsold ?? []).map((p) => Number(p.shopify_id))];

    const asOf = new Date();
    const { runId, policyVersion, result } = await runAndRecordEconomics({ shopKey: key, productIds: ids, trigger: "check", requestedBy: BY, asOf });
    const stored = await repo.economicsRun(key, runId);
    if (!stored) throw new Error("run not recorded");

    // 1. Reproducibility from what was stored.
    let reproduced = 0;
    for (const r of stored.recommendations) {
      const args = r.inputs as Parameters<typeof recommendProduct>[0];
      expect(recommendProduct(args), `product ${r.product_id}`).toEqual(r.outputs);
      reproduced += 1;
    }

    // 2. Safeguards.
    const outputs = result.recommendations.map((r) => r.output);
    for (const o of outputs) {
      const b = o.budget;
      if (o.verdict === "BLOCKED" || o.verdict === "DO_NOT_LAUNCH") expect([b.test_budget, b.daily_budget]).toEqual([0, 0]);
      if (o.verdict === "INSUFFICIENT_DATA") expect([b.test_budget, b.daily_budget]).toEqual([null, null]);
      if (b.status === "recommended") for (const c of Object.values(b.ceilings)) if (c !== null) expect(b.test_budget!).toBeLessThanOrEqual(c);
      const e = o.economics;
      if (e.break_even_cpa !== null) {
        expect(e.target_cpa!).toBeLessThanOrEqual(e.maximum_viable_cpa!);
        expect(e.maximum_viable_cpa!).toBeLessThanOrEqual(e.break_even_cpa);
      }
    }
    const total = outputs.reduce((t, o) => t + (o.budget.test_budget ?? 0), 0);
    if (result.portfolio?.available != null) expect(total).toBeLessThanOrEqual(result.portfolio.available + 1e-9);

    // 3. The top product by hand: omni-beta's orders carry no discounts, shipping or tax, so
    //    net revenue = price × units per order × (1 − refund rate), and costs follow the inputs above.
    const top = result.recommendations.find((r) => r.product_id === sold[0]);
    let handCheck: Record<string, number> | null = null;
    if (top && top.output.economics.contribution !== null && process.env.LIVE_SYNTHETIC_INPUTS === "1") {
      const p = top.args.product;
      const soldVariants = p.variants.filter((v) => v.units > 0);
      const units = soldVariants.reduce((t, v) => t + v.units, 0);
      const price = soldVariants.reduce((t, v) => t + v.price * v.units, 0) / units;
      const cost = soldVariants.reduce((t, v) => t + (v.unit_cost ?? 0) * v.units, 0) / units;
      const upo = p.sales.units / p.sales.orders;
      const refundRate = top.output.economics.rates.refund.value!;
      const returns = top.output.economics.rates.return_incidence.value!;
      const recovery = top.output.economics.rates.recovery.value!;
      const gross = price * upo;
      const net = gross - gross * refundRate;
      const costs = cost * upo * (1 - recovery) + 2500 + 500 + (0.015 * gross + 100) + returns * 1500;
      handCheck = { gross, net, costs, contribution: net - costs, engine_contribution: top.output.economics.contribution };
      // Each line is rounded to the kobo by the engine, so allow a few kobo.
      expect(Math.abs(handCheck.contribution - handCheck.engine_contribution)).toBeLessThan(0.1);
    }

    // 4. Campaign results flow into the verdict (synthetic results, labelled; the campaign is ended afterwards).
    let campaign: Record<string, unknown> | null = null;
    if (process.env.LIVE_CAMPAIGN === "1" && top?.output.economics.target_cpa) {
      const target = top.output.economics.target_cpa;
      const fx = 1550;
      const perDay = 100; // USD
      const conversions = Math.max(1, Math.round((perDay * fx) / (0.55 * target)));
      // Results through yesterday, as a merchant entering them daily would have.
      const days = Array.from({ length: 20 }, (_, i) => ({
        day: new Date(Date.now() - (20 - i) * 86_400_000).toISOString().slice(0, 10), spend: perDay, conversions, conversion_value: null, clicks: null, impressions: null,
        fx_to_shop: fx, fx_source: "synthetic rate for Phase 4 verification", fx_as_of: new Date(Date.now() - 21 * 86_400_000).toISOString(),
      }));
      const campaignFields = { name: "Phase 4 verification (SYNTHETIC results)", platform: "meta", product_ids: [top.product_id], currency: "USD", daily_budget: perDay,
        authorised_budget: perDay * fx * 30, max_loss: 2_000_000, started_on: days[0].day, recommendation_run_id: runId };
      const id = await repo.saveAdCampaign(key, { ...campaignFields, status: "active" }, BY);
      await repo.saveAdCampaignResults(key, id, days, BY);
      const policy = await repo.economicsPolicy();
      const checkedAt = new Date();
      const first = (await evaluateShopCampaigns({ shopKey: key, requestedBy: BY, asOf: checkedAt })).find((f) => f.campaign_id === id);
      let reviewed: typeof first;
      if (policy.settings.scale_confidence !== undefined) {
        // Version 3: Meta's synthetic count (far above this product's real orders) cannot reconcile, so scaling is withheld…
        expect(first?.action).toBe("CONTINUE");
        expect(first?.reconciliation?.scaling_allowed).toBe(false);
        // …until a review covering the matured results is recorded.
        const lastMatured = days.map((d) => d.day).filter((d) => Date.parse(`${d}T00:00:00Z`) <= checkedAt.getTime() - 7 * 86_400_000).at(-1) as string;
        await repo.saveAdCampaignReview(key, id, { through_day: lastMatured, outcome: "confirmed", note: "Phase 4 verification (SYNTHETIC): counts reviewed." }, BY);
        reviewed = (await evaluateShopCampaigns({ shopKey: key, requestedBy: BY, asOf: new Date() })).find((f) => f.campaign_id === id);
        expect(reviewed).toMatchObject({ action: "SCALE", reasons: ["ATTRIBUTION_REVIEWED"] });
        // Both evaluations are recorded with the policy, calc version and inputs, and recompute exactly.
        const { data: stored } = await supabaseAdmin.from("ad_campaign_evaluations").select("action, policy_version, calc_version, inputs, output")
          .eq("shop_key", key).eq("campaign_id", id).order("created_at");
        expect((stored ?? []).map((r) => [r.action, r.policy_version, r.calc_version])).toEqual([["CONTINUE", policy.version, "econ-1.2.0"], ["SCALE", policy.version, "econ-1.2.0"]]);
        const { evaluateCampaign } = await import("./feedback");
        for (const r of stored ?? []) expect(JSON.parse(JSON.stringify(evaluateCampaign(r.inputs)))).toEqual(r.output);
      }
      await repo.saveAdCampaign(key, { ...campaignFields, id, status: "ended", ended_on: checkedAt.toISOString().slice(0, 10) }, BY);
      const after = await runAndRecordEconomics({ shopKey: key, productIds: [top.product_id], trigger: "check", requestedBy: BY, asOf: checkedAt });
      const rec = after.result.recommendations[0].output;
      expect(rec.confidence.acquisition).toBe("proven");
      expect(first).toBeDefined();
      const summarise = (f: typeof first) => f && { action: f.action, reasons: f.reasons, cpa: f.measure.cpa, cpa_upper: f.measure.cpa_upper, matured_sales: f.measure.matured_conversions,
        break_even: f.break_even_cpa, target: f.target_cpa, next_daily: f.next_daily_budget, fx: f.measure.fx, attribution_lag_days: f.measure.attribution_lag_days,
        confidence: f.measure.confidence, reconciliation: f.reconciliation };
      campaign = { id, conversions_per_day: conversions, feedback: summarise(first), after_review: summarise(reviewed),
        verdict_after: rec.verdict, reasons_after: rec.reasons, budget_after: rec.budget };
    }

    const unviable = result.recommendations.filter((r) => r.output.verdict === "DO_NOT_LAUNCH").map((r) => ({ product_id: r.product_id,
      price_per_unit: r.output.economics.price_per_unit, unit_cost_per_unit: r.output.economics.unit_cost_per_unit, net_revenue: r.output.economics.net_revenue,
      variable_costs: r.output.economics.variable_costs, contribution: r.output.economics.contribution }));
    const verdicts: Record<string, number> = {};
    for (const o of outputs) verdicts[o.verdict] = (verdicts[o.verdict] ?? 0) + 1;
    const reasons: Record<string, number> = {};
    for (const o of outputs) for (const r of o.reasons) reasons[r] = (reasons[r] ?? 0) + 1;
    const summary = {
      domain, run_id: runId, policy_version: policyVersion, as_of: asOf.toISOString(), products: outputs.length, reproduced, verdicts, reasons,
      calc_versions: [...new Set(outputs.map((o) => o.economics.calc_version))], notes: outputs.reduce((acc: Record<string, number>, o) => {
        for (const n of o.notes) acc[n] = (acc[n] ?? 0) + 1; return acc; }, {}),
      refund_timing: await (async () => {
        const policy = await repo.economicsPolicy();
        const lag = policy.settings.refund_lag_min_refunds !== undefined ? await repo.storeRefundLag(key, asOf, policy.settings.sales_window_days) : null;
        return { lag, maturity_days: repo.refundMaturityDays(policy.settings, lag) };
      })(),
      recommended_total: total, portfolio: result.portfolio && { monthly_limit: result.portfolio.monthly_limit, available: result.portfolio.available,
        allocated: result.portfolio.allocated, outcomes: result.portfolio.allocations.reduce((acc: Record<string, number>, a) => ({ ...acc, [a.outcome]: (acc[a.outcome] ?? 0) + 1 }), {}) },
      top: top && { product_id: top.product_id, verdict: top.output.verdict, reasons: top.output.reasons, notes: top.output.notes, confidence: top.output.confidence,
        economics: { net_revenue: top.output.economics.net_revenue, variable_costs: top.output.economics.variable_costs, contribution: top.output.economics.contribution,
          break_even_cpa: top.output.economics.break_even_cpa, maximum_viable_cpa: top.output.economics.maximum_viable_cpa, target_cpa: top.output.economics.target_cpa,
          calc_version: top.output.economics.calc_version, purchase_event_basis: top.output.economics.purchase_event_basis ?? null,
          break_even_cpa_per_paid_order: top.output.economics.break_even_cpa_per_paid_order ?? null, failed_delivery: top.output.economics.failed_delivery ?? null,
          rates: Object.fromEntries(Object.entries(top.output.economics.rates).map(([k, v]) => [k, [v.value, v.stress, v.provenance, v.sample]])),
          lines: Object.fromEntries(Object.entries(top.output.economics.lines).map(([k, l]) => [k, [l.amount, l.provenance]])) },
        budget: top.output.budget },
      hand_check: handCheck, campaign, unviable,
      budgets: result.recommendations.map((r) => [r.product_id, r.output.verdict, r.output.budget.status, r.output.budget.test_budget, r.output.budget.binding]),
    };
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, JSON.stringify(summary, null, 2));
  }, 600_000);
});
