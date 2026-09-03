import { MapPin, CalendarClock, Wallet, HeartHandshake } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";

export interface BuyerProfileProps {
  locationText: string;
  peakDays: string[];
  aov: number;
  repeatRate: number;
  currency: string;
}

function Row({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-surface-subtle text-brand-600 [&_svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-faint-foreground">
          {label}
        </p>
        <p className="mt-0.5 text-sm font-medium text-foreground">{value}</p>
        {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}

export function BuyerProfile({
  locationText,
  peakDays,
  aov,
  repeatRate,
  currency,
}: BuyerProfileProps) {
  const hasIntl = /United States|United Kingdom|London|New York|Canada|Ghana/i.test(locationText);
  const locationSub = hasIntl ? "Overseas orders detected (US/UK)" : undefined;

  const isHighAov = currency === "NGN" ? aov >= 100000 : aov >= 75;
  const isMidAov = currency === "NGN" ? aov >= 30000 : aov >= 35;

  const spendSub =
    isHighAov
      ? "Premium shoppers — highlight fabric quality, fit, and craftsmanship"
      : isMidAov
        ? "Mid-market shoppers — highlight style and everyday comfort"
        : "Budget-friendly — highlight value and best-sellers";

  const loyaltySub =
    repeatRate < 0.15
      ? "Most buyers are new — ads will help expand your customer base"
      : repeatRate <= 0.3
        ? "Healthy repeat rate — great for testing new arrivals"
        : "High loyalty — your shoppers love returning";

  const whenSub =
    peakDays.length > 0
      ? `Launch ads before ${peakDays[0]} to catch the shopping rush`
      : undefined;

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Your buyers</CardTitle>
      </CardHeader>
      <div className="space-y-5 px-6 pb-6">
        <Row icon={<MapPin />} label="Where they buy from" value={locationText} sub={locationSub} />
        <Row
          icon={<CalendarClock />}
          label="When they buy"
          value={`Peak days: ${peakDays.length > 0 ? peakDays.join(", ") : "—"}`}
          sub={whenSub}
        />
        <Row
          icon={<Wallet />}
          label="How much they spend"
          value={`Average order: ${formatCurrency(Math.round(aov), currency)}`}
          sub={spendSub}
        />
        <Row
          icon={<HeartHandshake />}
          label="Loyalty"
          value={`${Math.round(repeatRate * 100)}% buy again`}
          sub={loyaltySub}
        />
      </div>
    </Card>
  );
}
