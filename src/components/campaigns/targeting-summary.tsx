import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import type { AiInsights, StoreInsights } from "./types";

export function TargetingSummary({
  storeInsights,
  aiInsights,
  loadingAiInsights,
}: {
  storeInsights: StoreInsights | null;
  aiInsights: AiInsights | null;
  loadingAiInsights: boolean;
}) {
  const t = aiInsights?.targeting;

  const locationText =
    t?.locations && t.locations.length > 0
      ? t.locations
          .map((l) => (l?.name || l?.city || "").split(",")[0].trim())
          .filter(Boolean)
          .join(" · ")
      : storeInsights?.orders?.top_locations && storeInsights.orders.top_locations.length > 0
        ? storeInsights.orders.top_locations.map((l) => `${l.city}`).filter(Boolean).join(" · ")
        : "No order data yet — add locations manually based on your target market";

  return (
    <Card className="p-6">
      <h3 className="mb-5 text-sm font-semibold uppercase tracking-widest text-subtle-foreground">
        Targeting settings
      </h3>

      {storeInsights ? (
        <div className="space-y-5">
          <Field label="Locations" value={locationText} />

          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Age range"
              value={t?.age_min ? `${t.age_min} — ${t.age_max}` : loadingAiInsights ? "Analyzing…" : "25 — 44 (default)"}
              hint={t?.age_reasoning}
            />
            <Field
              label="Gender"
              value={t?.gender || (loadingAiInsights ? "Analyzing…" : "All")}
              hint={t?.gender_reasoning}
              capitalize
            />
          </div>

          <div>
            <Label>Interests to add in Meta</Label>
            <div className="mt-2 flex flex-wrap gap-2">
              {t?.interests && t.interests.length > 0 ? (
                t.interests.map((interest, i) => (
                  <Badge key={i} variant="brand">
                    {interest}
                  </Badge>
                ))
              ) : loadingAiInsights ? (
                <span className="text-xs italic text-subtle-foreground">
                  Generating interests from your product catalogue…
                </span>
              ) : (
                <span className="text-xs italic text-subtle-foreground">
                  Connect your Shopify store for AI-inferred interests
                </span>
              )}
            </div>
            {t?.interest_reasoning && (
              <p className="mt-2 text-xs text-subtle-foreground">{t.interest_reasoning}</p>
            )}
          </div>

          <div>
            <Label>Behaviours to add</Label>
            <div className="mt-2 flex flex-wrap gap-2">
              {(t?.behaviours || ["Engaged Shoppers"]).map((b) => (
                <Badge key={b} variant="success">
                  {b}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <Alert variant="brand">
          Connect your Shopify store in Settings for personalised targeting based on
          your actual customers.
        </Alert>
      )}
    </Card>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-faint-foreground">
      {children}
    </span>
  );
}

function Field({
  label,
  value,
  hint,
  capitalize,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  capitalize?: boolean;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <p className={`mt-1 text-sm text-foreground ${capitalize ? "capitalize" : ""}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-subtle-foreground">{hint}</p>}
    </div>
  );
}
