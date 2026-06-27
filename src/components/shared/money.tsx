import * as React from "react";
import { formatCurrency } from "@/lib/utils";

export interface MoneyProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: number;
  symbol?: string;
  compact?: boolean;
}

export function Money({ value, symbol = "$", compact, ...props }: MoneyProps) {
  return (
    <span {...props}>{formatCurrency(value, symbol, { compact })}</span>
  );
}
