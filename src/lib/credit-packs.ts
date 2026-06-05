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
    name: "Starter Pack",
    tagline: "5 Campaign Briefs",
    description: "Perfect for testing your first collection and identifying initial winners.",
    credits: 5,
    unlimited_days: 0,
    price_usd: 39,
    price_ngn: 58500,
    period: "",
    highlight: false,
    features: [
      "5 Campaign Briefs",
      "Store Intelligence Insights",
      "Creative Angle Blueprints",
      "Valid for 12 months",
    ],
  },
  {
    id: "growth",
    name: "Growth Pack",
    tagline: "Best Choice",
    description: "For growing brands scaling multiple styles and running weekly tests.",
    credits: 15,
    unlimited_days: 0,
    price_usd: 99,
    price_ngn: 148500,
    period: "",
    highlight: true,
    features: [
      "15 Campaign Briefs",
      "Everything in Starter Pack",
      "Ideal for testing 3+ products",
      "Save 15% per brief ($6.60 / brief)",
    ],
  },
  {
    id: "scale",
    name: "Scale Pack",
    tagline: "Best Value",
    description: "High volume for massive collection drops and rapid creative testing.",
    credits: 30,
    unlimited_days: 0,
    price_usd: 179,
    price_ngn: 268500,
    period: "",
    features: [
      "30 Campaign Briefs",
      "Everything in Growth Pack",
      "Ideal for full catalog coverage",
      "Best Value ($5.96 / brief)",
    ],
  },
];

export function getPackById(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find(p => p.id === id);
}
