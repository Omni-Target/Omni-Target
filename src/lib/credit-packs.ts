export interface CreditPack {
  id: "single" | "starter" | "growth" | "scale";
  name: string;
  tagline: string;
  description: string;
  credits: number;
  unlimited_days: number;
  price_usd: number;
  price_ngn: number;
  stripe_price_id?: string;
  highlight?: boolean;
  dashed?: boolean;
  period?: string;
  features: string[];
}

export const CREDIT_PACKS: CreditPack[] = [
  {
    id: "single",
    name: "Single Brief",
    tagline: "Pay as you go · zero commitment",
    description: "Full intelligence brief for one product.",
    credits: 1,
    unlimited_days: 0,
    price_usd: 19,
    price_ngn: 28500,
    period: "",
    features: [
      "1 campaign brief",
      "AI copy generation",
      "Store intelligence targeting",
      "PDF brief download",
      "Valid for 6 months",
    ],
  },
  {
    id: "starter",
    name: "Starter Bundle",
    tagline: "3 briefs · saves $8",
    description: "Test multiple products or hooks without a subscription.",
    credits: 3,
    unlimited_days: 0,
    price_usd: 49,
    price_ngn: 73500,
    period: "",
    highlight: true,
    features: [
      "3 campaign briefs",
      "Everything in Single Brief",
      "Priority AI processing",
      "Multi-product campaigns",
      "Valid for 6 months",
    ],
  },
  {
    id: "growth",
    name: "Growth Bundle",
    tagline: "7 briefs · saves $34",
    description: "For brands running multiple tests and scaling.",
    credits: 7,
    unlimited_days: 0,
    price_usd: 99,
    price_ngn: 148500,
    period: "",
    features: [
      "7 campaign briefs",
      "Everything in Starter Bundle",
      "Dedicated account manager",
      "Custom integrations",
      "Valid for 6 months",
    ],
  },
  {
    id: "scale",
    name: "Scale Subscription",
    tagline: "Unlimited briefs · unlocks after 1st use",
    description: "Full access for high-volume stores.",
    credits: 0,
    unlimited_days: 30,
    price_usd: 79,
    price_ngn: 118500,
    period: "/ month",
    dashed: true,
    features: [
      "Unlimited briefs for 30 days",
      "Everything in Growth Bundle",
      "Early access to new features",
      "Priority support",
    ],
  },
];

export function getPackById(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find(p => p.id === id);
}
