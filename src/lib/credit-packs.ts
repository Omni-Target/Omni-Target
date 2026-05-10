export interface CreditPack {
  id: "launch" | "growth" | "agency";
  name: string;
  description: string;
  credits: number;
  unlimited_days: number;
  price_usd: number;
  price_ngn: number;
  stripe_price_id?: string;
  highlight?: boolean;
}

export const CREDIT_PACKS: CreditPack[] = [
  {
    id: "launch",
    name: "Launch",
    description: "Perfect for testing your first campaigns",
    credits: 5,
    unlimited_days: 0,
    price_usd: 29,
    price_ngn: 45000,
  },
  {
    id: "growth",
    name: "Growth",
    description: "For active brands running regular campaigns",
    credits: 20,
    unlimited_days: 0,
    price_usd: 79,
    price_ngn: 122000,
    highlight: true,
  },
  {
    id: "agency",
    name: "Agency",
    description: "Unlimited briefs for 90 days",
    credits: 0,
    unlimited_days: 90,
    price_usd: 149,
    price_ngn: 230000,
  },
];

export function getPackById(
  id: string
): CreditPack | undefined {
  return CREDIT_PACKS.find(p => p.id === id);
}
