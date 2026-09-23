import { MapPin, CalendarClock, Wallet, HeartHandshake, Compass } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";

export interface BuyerProfileProps {
  locationText: string;
  locationLevel?: "city" | "country" | "commercial_hubs" | "missing";
  peakDays: string[];
  aov: number;
  repeatRate: number;
  currency: string;
  topChannel?: string;
  topChannelPercentage?: number;
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
  locationLevel = "city",
  peakDays,
  aov,
  repeatRate,
  currency,
  topChannel,
  topChannelPercentage,
}: BuyerProfileProps) {
  const hasIntl = /United States|United Kingdom|London|New York|Canada|Ghana|Houston/i.test(locationText);
  const locationSub =
    locationLevel === "commercial_hubs" || locationLevel === "country"
      ? hasIntl
        ? "Top commercial hubs · Cross-border orders recorded (ideal for diaspora targeting)"
        : "Top commercial hubs · Concentrates budget where courier delivery and purchasing power are highest"
      : locationLevel === "missing"
        ? "Broad market targeting recommended for initial ad tests"
        : hasIntl
          ? "Cross-border demand recorded in UK & US · Ideal for high-margin diaspora targeting"
          : "Proven buyer locations recorded directly from your past customer orders";

  const isHighAov = currency === "NGN" ? aov >= 100000 : aov >= 75;
  const isMidAov = currency === "NGN" ? aov >= 30000 : aov >= 35;

  const spendSub =
    isHighAov
      ? "High-ticket luxury basket · Spotlight craftsmanship, unboxing & styling to build trust"
      : isMidAov
        ? "Balanced everyday basket · Showcase versatility and real-world styling"
        : "Accessible impulse price · Highlight bundle value and fast checkout";

  const loyaltySub =
    repeatRate < 0.15
      ? "Focus ad creative on converting first-time buyers with an irresistible starter piece"
      : repeatRate <= 0.3
        ? "Solid repeat baseline · Pair new buyer acquisition with retargeting"
        : "Exceptional customer loyalty · High repeat value gives you healthy margin for ads";

  const whenSub =
    peakDays.length > 0
      ? `Launch fresh creative ahead of ${peakDays.slice(0, 2).join(" & ")} to catch shoppers at their peak`
      : undefined;

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Your buyers</CardTitle>
      </CardHeader>
      <div className="space-y-5 px-6 pb-6">
        <Row icon={<MapPin />} label="Where they buy from" value={locationText} sub={locationSub} />
        {topChannel && (
          <Row
            icon={<Compass />}
            label="How they find you"
            value={topChannelPercentage ? `${topChannel} (${topChannelPercentage}% of orders)` : topChannel}
            sub="Your top organic conversion channel"
          />
        )}
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
