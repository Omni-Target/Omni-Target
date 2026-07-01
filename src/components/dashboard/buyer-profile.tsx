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
  const spendSub =
    aov > 100000
      ? "Premium buyers — target higher income audiences"
      : aov >= 30000
        ? "Mid-market buyers — broad targeting works well"
        : "Value-conscious buyers — focus on deals and new arrivals";

  const loyaltySub =
    repeatRate < 0.15
      ? "Most buyers are new. Focus ads on acquisition."
      : repeatRate <= 0.3
        ? "Healthy loyalty. Test retargeting campaigns."
        : "Strong loyalty. Create lookalike audiences from your best customers.";

  const whenSub =
    peakDays.length > 0
      ? `Launch campaigns on ${
          peakDays[0] === "Saturday" || peakDays[0] === "Sunday"
            ? "Friday evening"
            : "the day before"
        } to catch your ${peakDays[0]} buyers`
      : undefined;

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Your buyers</CardTitle>
      </CardHeader>
      <div className="space-y-5 px-6 pb-6">
        <Row icon={<MapPin />} label="Where they buy from" value={locationText} />
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
