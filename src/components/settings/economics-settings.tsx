"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The merchant's costs, expected rates and advertising limits (Phase 4, task 8). These feed the deterministic
 * economics engine; nothing here is a default. A blank field is unknown (and blocks a recommendation where the
 * cost is essential), "Doesn't apply" is the merchant's explicit confirmation that a cost is zero, and expected
 * rates are used only when the store has no history of its own. Saved through PUT /api/economics/inputs, which
 * the database validates again.
 */
type Kind = "money" | "percent";
type State = "merchant_entered" | "confirmed_none" | "merchant_estimate";
interface FieldDef { key: string; label: string; hint: string; kind: Kind; canBeNone: boolean; state: Exclude<State, "confirmed_none"> }

const GROUPS: Array<{ title: string; description: string; fields: FieldDef[] }> = [
  {
    title: "Costs per order",
    description: "What each order costs you beyond the product. Leave a field blank if you do not know it: no recommendation is made without it.",
    fields: [
      { key: "payment_rate", label: "Payment processing rate", hint: "% of the amount charged", kind: "percent", canBeNone: true, state: "merchant_entered" },
      { key: "payment_fixed_fee", label: "Fixed payment fee per order", hint: "Per order", kind: "money", canBeNone: true, state: "merchant_entered" },
      { key: "selling_fee_rate", label: "Other selling fees", hint: "% of net revenue, e.g. third-party transaction fees", kind: "percent", canBeNone: true, state: "merchant_entered" },
      { key: "shipping_cost_per_order", label: "Shipping cost per order", hint: "What you pay to ship one order", kind: "money", canBeNone: true, state: "merchant_entered" },
      { key: "fulfilment_cost_per_order", label: "Fulfilment cost per order", hint: "Pick, pack, packaging", kind: "money", canBeNone: true, state: "merchant_entered" },
      { key: "fulfilment_cost_per_unit", label: "Fulfilment cost per unit", hint: "Per item", kind: "money", canBeNone: true, state: "merchant_entered" },
      { key: "landed_cost_rate", label: "Landed costs not in your Shopify unit cost", hint: "% of unit cost: freight, duties", kind: "percent", canBeNone: true, state: "merchant_entered" },
      { key: "return_handling_cost", label: "Cost of handling one return", hint: "Including return shipping you pay", kind: "money", canBeNone: true, state: "merchant_entered" },
    ],
  },
  {
    title: "Expected rates",
    description: "Used only when there is no order history to measure them from, and always labelled as your estimate.",
    fields: [
      { key: "expected_discount_rate", label: "Expected discount", hint: "% of price", kind: "percent", canBeNone: false, state: "merchant_estimate" },
      { key: "expected_refund_rate", label: "Expected refunds", hint: "% of revenue", kind: "percent", canBeNone: false, state: "merchant_estimate" },
      { key: "expected_return_rate", label: "Expected returns", hint: "Returns per 100 orders", kind: "percent", canBeNone: false, state: "merchant_estimate" },
    ],
  },
  {
    title: "Advertising limits",
    description: "Omnitarget never recommends spending above these. Without a limit, no budget amount is recommended.",
    fields: [
      { key: "ad_monthly_limit", label: "Total advertising per month", hint: "Across all products", kind: "money", canBeNone: false, state: "merchant_entered" },
      { key: "ad_test_limit", label: "Most for one product test", hint: "Per test", kind: "money", canBeNone: false, state: "merchant_entered" },
      { key: "ad_daily_limit", label: "Most per day for one product", hint: "Per day", kind: "money", canBeNone: false, state: "merchant_entered" },
      { key: "ad_max_loss", label: "Most you will lose on one test", hint: "The test stops here", kind: "money", canBeNone: false, state: "merchant_entered" },
    ],
  },
];
const ALL = GROUPS.flatMap((g) => g.fields);

interface Stored { key: string; value: number; state: State; entered_at: string }
interface Row { text: string; none: boolean }

const toText = (f: FieldDef, s: Stored | undefined): Row => {
  if (!s) return { text: "", none: false };
  if (s.state === "confirmed_none") return { text: "", none: true };
  return { text: String(f.kind === "percent" ? Math.round(Number(s.value) * 1e6) / 1e4 : Number(s.value)), none: false };
};

const byKey = (inputs: Stored[]) => Object.fromEntries(inputs.map((i) => [i.key, i])) as Record<string, Stored>;
const rowsFor = (stored: Record<string, Stored>) => Object.fromEntries(ALL.map((f) => [f.key, toText(f, stored[f.key])])) as Record<string, Row>;

/** `initial` is read by the settings page on the server; null when no store is connected. */
export function EconomicsSettings({ initial }: { initial: { currency: string | null; inputs: Stored[] } | null }) {
  const formId = useId();
  const [currency, setCurrency] = useState<string | null>(initial?.currency ?? null);
  const [stored, setStored] = useState<Record<string, Stored>>(byKey(initial?.inputs ?? []));
  const [rows, setRows] = useState<Record<string, Row>>(rowsFor(byKey(initial?.inputs ?? [])));
  const [status, setStatus] = useState<"ready" | "saving" | "error">("ready");
  const [message, setMessage] = useState<string | null>(null);

  const reload = async () => {
    const response = await fetch("/api/economics/inputs");
    if (!response.ok) return;
    const data = (await response.json()) as { currency: string | null; inputs: Stored[] };
    const next = byKey(data.inputs);
    setStored(next);
    setCurrency(data.currency);
    setRows(rowsFor(next));
  };

  const save = async () => {
    const changes: Array<Record<string, unknown>> = [];
    for (const f of ALL) {
      const row = rows[f.key] ?? { text: "", none: false };
      if (row.none) { changes.push({ key: f.key, value: 0, state: "confirmed_none" }); continue; }
      if (row.text.trim() === "") { if (stored[f.key]) changes.push({ key: f.key, state: "cleared" }); continue; }
      const n = Number(row.text.replace(/[,\s]/g, ""));
      if (!Number.isFinite(n) || n < 0) { setMessage(`${f.label}: enter a number of zero or more.`); setStatus("error"); return; }
      changes.push({ key: f.key, value: f.kind === "percent" ? n / 100 : n, state: f.state });
    }
    setStatus("saving");
    setMessage(null);
    const response = await fetch("/api/economics/inputs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes }) });
    if (!response.ok) {
      setMessage(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "Your costs could not be saved.");
      setStatus("error");
      return;
    }
    setMessage("Saved. Briefs use these figures the next time their economics are calculated.");
    setStatus("ready");
    await reload();
  };

  if (!initial) return <p className="text-sm text-muted-foreground">Connect your Shopify store to enter your costs.</p>;

  return (
    <form id={formId} className="space-y-6" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {GROUPS.map((group) => (
        <fieldset key={group.title} className="space-y-3">
          <legend className="text-sm font-semibold text-foreground">{group.title}</legend>
          <p className="text-xs text-muted-foreground">{group.description}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {group.fields.map((f) => {
              const row = rows[f.key] ?? { text: "", none: false };
              const unit = f.kind === "percent" ? "%" : currency ?? "";
              const inputId = `${formId}-${f.key}`;
              return (
                <div key={f.key} className="space-y-1 rounded-lg border border-border-subtle px-3 py-2">
                  <label htmlFor={inputId} className="text-xs font-medium text-foreground">{f.label} {unit && <span className="text-muted-foreground">({unit})</span>}</label>
                  <Input id={inputId} inputMode="decimal" value={row.text} disabled={row.none || status === "saving"} placeholder="Unknown"
                    onChange={(event) => setRows({ ...rows, [f.key]: { ...row, text: event.target.value } })} />
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span>{f.hint}</span>
                    {f.canBeNone && (
                      <label className="flex items-center gap-1">
                        <input type="checkbox" checked={row.none} onChange={(event) => setRows({ ...rows, [f.key]: { text: "", none: event.target.checked } })} />
                        Doesn&apos;t apply
                      </label>
                    )}
                  </div>
                  {stored[f.key] && <p className="text-[11px] text-subtle-foreground">Last saved {new Date(stored[f.key].entered_at).toLocaleDateString()}</p>}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
      {message && <p role={status === "error" ? "alert" : "status"} className={status === "error" ? "text-sm text-red-600" : "text-sm text-muted-foreground"}>{message}</p>}
      <Button type="submit" disabled={status === "saving"}>{status === "saving" ? "Saving…" : "Save costs and limits"}</Button>
    </form>
  );
}
