import { renderToStaticMarkup } from "react-dom/server";
import { BriefStep } from "@/components/campaigns/steps/brief-step";
import { buildBriefPdfPayload, buildBriefText, budgetPlanFor } from "@/lib/campaigns/brief";
import { savedMaxTestBudget } from "@/lib/budget-plan";
import { parseBriefEconomics, type BriefEconomics } from "@/lib/brief-economics";
import { buildBriefHTML } from "@/lib/brief-html-template";
import type { BriefPDFParams } from "@/lib/brief-pdf-types";
import type { AiInsights, GeneratedCopy, StoreInsights } from "@/components/campaigns/types";

/**
 * Everything a saved brief shows that depends on its store evidence: the PDF
 * payload and HTML, the copied text, the budget plan and the rendered brief.
 * Used to prove that trimming a brief (task 9) changes none of them. Tests and
 * verification only; never imported by the application.
 */
export interface BriefRenderingInput {
  storeInsights: StoreInsights | null;
  aiInsights: AiInsights | null;
  generatedCopy: GeneratedCopy;
  selectedCta: string;
  productName: string;
  brandName: string;
  goal: string;
  productPrice?: number;
  generatedAt?: string;
  gatewayInsight?: BriefPDFParams["gatewayInsight"] | null;
  isNewLaunch?: boolean;
  maxTestBudget: number | null;
  /** Phase 4: the engine's recorded economics snapshot, when the brief has one. */
  economics?: BriefEconomics | null;
  selectedDuration: 7 | 14 | 30;
  selectedIntlDuration?: 7 | 14 | 30;
  selectedStrategyIndex?: number;
  selectedIntlStrategyIndex?: number;
}

export async function briefRenderings(input: BriefRenderingInput) {
  const common = {
    aiInsights: input.aiInsights,
    storeInsights: input.storeInsights,
    selectedDuration: input.selectedDuration,
    selectedIntlDuration: input.selectedIntlDuration ?? 14,
    selectedStrategyIndex: input.selectedStrategyIndex ?? 1,
    selectedIntlStrategyIndex: input.selectedIntlStrategyIndex ?? 1,
    maxTestBudget: input.maxTestBudget,
    economics: input.economics ?? null,
    gatewayInsight: input.gatewayInsight ?? null,
  };
  const payload = buildBriefPdfPayload({
    ...common, generatedAt: input.generatedAt, brandName: input.brandName, productName: input.productName,
    productPrice: input.productPrice, goal: input.goal, generatedCopy: input.generatedCopy, selectedCta: input.selectedCta,
    isNewLaunch: input.isNewLaunch ?? false,
  });
  const html = await buildBriefHTML(payload);
  return {
    payload,
    // Each render carries a fresh CSP nonce; everything else must match.
    html: html.replace(/nonce-[A-Za-z0-9+/=]+/g, "nonce-X").replace(/nonce="[^"]*"/g, 'nonce="X"'),
    text: buildBriefText({ ...common, generatedCopy: input.generatedCopy, selectedCta: input.selectedCta, goal: input.goal }),
    plan: budgetPlanFor({ aiInsights: input.aiInsights, storeInsights: input.storeInsights, maxTestBudget: input.maxTestBudget, selectedDuration: input.selectedDuration }),
    markup: renderToStaticMarkup(
      <BriefStep
        generatedCopy={input.generatedCopy} copiedField={null} onCopy={() => {}} selectedCta={input.selectedCta}
        storeInsights={input.storeInsights} aiInsights={input.aiInsights} loadingAiInsights={false} goal={input.goal}
        selectedStrategyIndex={common.selectedStrategyIndex} setSelectedStrategyIndex={() => {}}
        selectedDuration={input.selectedDuration} setSelectedDuration={() => {}} isDownloadingPdf={false}
        onDownloadPdf={() => {}} onCopyBrief={() => {}} onCreateNew={() => {}} gatewayInsight={common.gatewayInsight}
        productPrice={input.productPrice} maxTestBudget={input.maxTestBudget} setMaxTestBudget={() => {}} economics={input.economics ?? null}
      />,
    ),
  };
}

type Saved = Record<string, unknown>;
const duration = (value: unknown): 7 | 14 | 30 => (value === 7 || value === 30 ? value : 14);

/** The renderings of one saved brief, with the settings it was saved with, as the brief view reads them. */
export function renderSavedBrief(brief: Saved, campaign: { product_name?: string | null; brand_name?: string | null; campaign_goal?: string | null; product_price?: string | null; cta?: string | null }) {
  const copy = (brief.generatedCopy ?? {}) as GeneratedCopy;
  return briefRenderings({
    storeInsights: (brief.storeInsights ?? null) as StoreInsights | null,
    aiInsights: (brief.aiInsights ?? null) as AiInsights | null,
    generatedCopy: copy,
    selectedCta: (brief.selectedCta ?? campaign.cta ?? copy.cta ?? "") as string,
    productName: (brief.productName ?? campaign.product_name ?? "") as string,
    brandName: (brief.brandName ?? campaign.brand_name ?? "") as string,
    goal: (brief.goal ?? campaign.campaign_goal ?? "") as string,
    productPrice: (brief.productPrice as number | undefined) ?? (campaign.product_price ? Number(campaign.product_price) : undefined),
    generatedAt: brief.generatedAt as string | undefined,
    gatewayInsight: (brief.gatewayInsight ?? null) as BriefPDFParams["gatewayInsight"] | null,
    isNewLaunch: (brief.isNewLaunch ?? false) as boolean,
    maxTestBudget: savedMaxTestBudget(brief),
    economics: parseBriefEconomics(brief.economics),
    selectedDuration: duration(brief.selectedDuration),
    selectedIntlDuration: duration(brief.selectedIntlDuration),
    selectedStrategyIndex: (brief.selectedStrategyIndex ?? 1) as number,
    selectedIntlStrategyIndex: (brief.selectedIntlStrategyIndex ?? 1) as number,
  });
}
