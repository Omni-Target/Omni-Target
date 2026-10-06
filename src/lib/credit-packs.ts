export interface CreditPack {
  id: "free" | "single" | "starter" | "growth" | "scale";
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
    id: "free",
    name: "Free Plan",
    tagline: "Included on install",
    description: "Get started with your first high-converting ad brief.",
    credits: 1,
    unlimited_days: 0,
    price_usd: 0,
    price_ngn: 0,
    period: "",
    highlight: false,
    features: [
      "1 free ad brief on install",
      "Find your top-converting product",
      "3 ready-to-use ad angles & hooks",
      "Step-by-step Meta setup guide",
    ],
  },
  {
    id: "starter",
    name: "Starter Pack",
    tagline: "3 ad briefs ($3.00 each)",
    description: "Test your top 3 products with custom video hooks.",
    credits: 3,
    unlimited_days: 0,
    price_usd: 9,
    price_ngn: 13500,
    period: "",
    highlight: false,
    features: [
      "3 ad briefs ($3.00 each)",
      "Test your top 3 products",
      "3 custom video hooks per item",
      "Credits valid for 12 months",
    ],
  },
  {
    id: "growth",
    name: "Growth Pack",
    tagline: "Best Choice · Save 17%",
    description: "Perfect for new collection drops and weekly testing.",
    credits: 10,
    unlimited_days: 0,
    price_usd: 25,
    price_ngn: 37500,
    period: "",
    highlight: true,
    features: [
      "10 ad briefs ($2.50 each)",
      "Perfect for new collection drops",
      "Save 17% vs Starter Pack",
      "Everything in Starter Pack",
    ],
  },
  {
    id: "scale",
    name: "Scale Pack",
    tagline: "Best Value · Save 34%",
    description: "Cover your entire store catalog with maximum savings.",
    credits: 30,
    unlimited_days: 0,
    price_usd: 59,
    price_ngn: 88500,
    period: "",
    highlight: false,
    features: [
      "30 ad briefs ($1.97 each)",
      "Cover your entire store catalog",
      "Best value (save 34%)",
      "Everything in Growth Pack",
    ],
  },
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
];

export function getPackById(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find(p => p.id === id);
}
