import { TrendingUp, ShoppingBag, Receipt, Repeat } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { formatCurrency } from "@/lib/currency";

export interface KpiRowProps {
  revenue30d?: number;
  orders30d: number;
  aov: number;
  repeatRate: number;
  activeProducts: number;
  totalProducts: number;
  currency: string;
}

export function KpiRow({
  revenue30d,
  orders30d,
  aov,
  repeatRate,
  activeProducts,
  totalProducts,
  currency,
}: KpiRowProps) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {typeof revenue30d === "number" && revenue30d > 0 ? (
        <Card className="p-5">
          <Stat
            label="Revenue · 30d"
            value={formatCurrency(Math.round(revenue30d), currency)}
            icon={<TrendingUp />}
          />
        </Card>
      ) : (
        <Card className="p-5">
          <Stat
            label="Active products"
            value={`${activeProducts}`}
            hint={`of ${totalProducts} in catalog`}
            icon={<ShoppingBag />}
          />
        </Card>
      )}
      <Card className="p-5">
        <Stat label="Orders · 30d" value={`${orders30d}`} icon={<ShoppingBag />} />
      </Card>
      <Card className="p-5">
        <Stat
          label="Avg order value"
          value={formatCurrency(Math.round(aov), currency)}
          icon={<Receipt />}
        />
      </Card>
      <Card className="p-5">
        <Stat
          label="Returning buyers"
          value={`${Math.round(repeatRate * 100)}%`}
          icon={<Repeat />}
        />
      </Card>
    </div>
  );
}
