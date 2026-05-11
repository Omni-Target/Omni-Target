export interface CreditPack {
  id: "launch" | "growth" | "agency";
  name: string;
  tagline: string;
  description: string;
  credits: number;
  unlimited_days: number;
  price_usd: number;
  price_ngn: number;
  stripe_price_id?: string;
  highlight?: boolean;
  features: string[];
}

export const CREDIT_PACKS: CreditPack[] = [
  {
    id: "launch",
    name: "Launch",
    tagline: "Start generating briefs today",
    description: "Perfect for testing your first campaigns",
    credits: 5,
    unlimited_days: 0,
    price_usd: 29,
    price_ngn: 45000,
    features: [
      "5 campaign briefs",
      "AI copy generation",
      "Store intelligence targeting",
      "PDF brief download",
      "Valid for 6 months",
    ],
  },
  {
    id: "growth",
    name: "Growth",
    tagline: "For brands running regular campaigns",
    description: "The most popular choice for active brands",
    credits: 20,
    unlimited_days: 0,
    price_usd: 79,
    price_ngn: 122000,
    highlight: true,
    features: [
      "20 campaign briefs",
      "Everything in Launch",
      "Priority AI processing",
      "Multi-product campaigns",
      "Valid for 6 months",
    ],
  },
  {
    id: "agency",
    name: "Agency",
    tagline: "Unlimited briefs for 90 days",
    description: "For brands with multiple product lines",
    credits: 0,
    unlimited_days: 90,
    price_usd: 149,
    price_ngn: 230000,
    features: [
      "Unlimited briefs for 90 days",
      "Everything in Growth",
      "Early access to new features",
      "Priority support",
    ],
  },
];

export function getPackById(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find(p => p.id === id);
}
