import jsPDF from "jspdf";
import { formatCurrency } from "./currency";

// ─── Brand Palette ───────────────────────────────────────────────────────────

const PAGE_BG   = [10, 10, 15]   as const;
const HEADER_BG = [14, 14, 22]   as const;
const CARD_BG   = [18, 18, 28]   as const;
const CARD_BD   = [40, 40, 58]   as const;
const ACCENT    = [124, 58, 237] as const;
const ACCENT_T  = [155, 115, 255] as const;
const WHITE     = [255, 255, 255] as const;
const TEXT_1    = [225, 225, 232] as const;
const TEXT_2    = [135, 135, 155] as const;
const TEXT_3    = [85, 85, 105]   as const;

// ─── Layout ──────────────────────────────────────────────────────────────────

const PW = 210;
const PH = 297;
const MX = 18;
const CW = PW - MX * 2;
const CP = 10;
const CR = 3;
const BOTTOM_SAFE = PH - 22;

// ─── Interface ───────────────────────────────────────────────────────────────

export interface BriefPDFParams {
  brandName: string;
  productName: string;
  campaignGoal: string;
  copy: {
    headline: string;
    primaryText: string;
    description: string;
    cta: string;
    copywriterNote: string;
  };
  targeting: {
    locations?: { name?: string; city?: string; source?: string }[];
    age_min?: number;
    age_max?: number;
    gender?: string;
    interests?: string[];
    behaviours?: string[];
    age_reasoning?: string;
    interest_reasoning?: string;
  };
  budget: {
    recommended_daily?: number;
    recommended_duration_days?: number;
    reasoning?: string;
    currency?: string;
    currency_symbol?: string;
    tier?: string;
    ad_sets?: number;
    optimization_event?: {
      event: string;
      reasoning: string;
    };
    breakdown?: {
      revenue_based: number;
      aov_based: number;
    };
    goal_adjusted_daily?: number;
    goal_label?: string;
  };
  timing: {
    peak_days?: string[];
    launch_recommendation?: string;
  };
  warnings: string[];
  generatedAt: string;
  gatewayInsight?: {
    currentProductClassification: string;
    currentProductName: string;
    currentProductImage: string;
    bestsellerName: string;
    topGatewayName: string;
    isBestsellerGateway: boolean;
    currentProductVelocity: number;
    currentProductRepeatRate: number;
    storeAov: number;
    storeBaseFtb: number;
  };
}

// ─── Generator ───────────────────────────────────────────────────────────────

export async function generateBriefPDF(params: BriefPDFParams): Promise<void> {
  const doc = new jsPDF();
  let y = 0;

  // ── Utilities ────────────────────────────────────────────────────────────

  type RGB = readonly [number, number, number];

  // Helper to sanitize unsupported Unicode and currency symbols for standard jsPDF fonts
  const sanitize = (text: string): string => {
    if (!text) return "";
    return text
      .replace(/₦/g, "NGN ")
      .replace(/GH₵/g, "GHS ")
      .replace(/₹/g, "INR ")
      .replace(/₺/g, "TRY ")
      .replace(/₽/g, "RUB ")
      .replace(/₱/g, "PHP ")
      .replace(/₪/g, "ILS ")
      .replace(/€/g, "EUR ")
      .replace(/₩/g, "KRW ")
      .replace(/₫/g, "VND ")
      .replace(/₴/g, "UAH ")
      .replace(/৳/g, "BDT ")
      .replace(/฿/g, "THB ")
      .replace(/\s*·\s*/g, " | ")
      .replace(/\s*⚠\s*/g, " [!] ")
      .replace(/—/g, "-");
  };

  const fillBg = () => {
    doc.setFillColor(...PAGE_BG);
    doc.rect(0, 0, PW, PH, "F");
  };

  const addPage = () => {
    doc.addPage();
    fillBg();
    // Brand strip on continuation pages
    doc.setFillColor(...ACCENT);
    doc.rect(0, 0, PW, 1.2, "F");
    // Muted wordmark on continuation pages
    doc.setFontSize(7);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...TEXT_3);
    doc.text("Omni Target", MX, 8);
    y = 14;
  };

  const ensureSpace = (h: number) => {
    if (y + h > BOTTOM_SAFE) addPage();
  };

  const font = (size: number, style: "normal" | "bold" | "italic" = "normal", color: RGB = TEXT_1) => {
    doc.setFontSize(size);
    doc.setFont("helvetica", style);
    doc.setTextColor(...color);
  };

  const measure = (text: string, size: number, w: number): string[] => {
    doc.setFontSize(size);
    return doc.splitTextToSize(sanitize(text), w);
  };

  const lh = (size: number, lineCount: number) => lineCount * size * 0.45;

  const innerW = CW - CP * 2;

  // ── Card System ──────────────────────────────────────────────────────────

  interface TItem {
    text: string;
    size: number;
    style?: "normal" | "bold" | "italic";
    color?: RGB;
    indent?: number;
    gapAfter?: number;
    image?: string;
    imageFormat?: string;
    imageW?: number;
    imageH?: number;
  }

  const itemH = (item: TItem): number => {
    let h = 0;
    if (item.text) {
      const lines = measure(item.text, item.size, innerW - (item.indent || 0));
      h += lh(item.size, lines.length);
    }
    if (item.image) {
      h += (item.imageH || 0);
    }
    return h + (item.gapAfter ?? 3);
  };

  const cardH = (label: string, items: TItem[]): number => {
    let h = CP + 8; // top padding + label row
    for (const item of items) h += itemH(item);
    return h + CP - 3; // bottom padding (minus last gap)
  };

  const renderCard = (label: string, items: TItem[]) => {
    const h = cardH(label, items);
    ensureSpace(h);

    // Card background
    doc.setFillColor(...CARD_BG);
    doc.setDrawColor(...CARD_BD);
    doc.setLineWidth(0.25);
    doc.roundedRect(MX, y, CW, h, CR, CR, "FD");

    // Accent top edge
    doc.setFillColor(...ACCENT);
    doc.roundedRect(MX, y, CW, 1, CR, CR, "F");

    const cardTop = y;
    y += CP;

    // Section label
    font(7.5, "bold", ACCENT_T);
    doc.text(label.toUpperCase(), MX + CP, y);
    y += 8;

    // Content
    for (const item of items) {
      const indent = item.indent || 0;
      if (item.text) {
        font(item.size, item.style || "normal", item.color || TEXT_1);
        const lines = measure(item.text, item.size, innerW - indent);
        doc.text(lines, MX + CP + indent, y);
        y += lh(item.size, lines.length);
      }
      if (item.image) {
        // Add a small gap before image if text was present
        if (item.text) y += 2;
        doc.addImage(item.image, item.imageFormat || "JPEG", MX + CP + indent, y, item.imageW || 30, item.imageH || 30);
        y += (item.imageH || 30);
      }
      y += (item.gapAfter ?? 3);
    }

    y = cardTop + h + 7;
  };

  // ── Page 1: Header ──────────────────────────────────────────────────────

  fillBg();

  // Header bar
  doc.setFillColor(...HEADER_BG);
  doc.rect(0, 0, PW, 44, "F");

  // Accent line
  doc.setFillColor(...ACCENT);
  doc.rect(0, 43, PW, 1.5, "F");

  // Wordmark
  font(20, "bold", WHITE);
  doc.text("Omni Target", MX, 18);

  // Accent dot after wordmark
  const wmWidth = doc.getTextWidth("Omni Target");
  doc.setFillColor(...ACCENT);
  doc.circle(MX + wmWidth + 4, 15.5, 1.8, "F");

  // Subtitle
  font(8, "normal", TEXT_3);
  doc.text("CAMPAIGN BRIEF", MX, 26);

  // Date
  font(8, "normal", TEXT_3);
  doc.text(params.generatedAt, PW - MX, 18, { align: "right" });

  // ── Hero Section ────────────────────────────────────────────────────────

  y = 54;
  font(18, "bold", WHITE);
  const productLines = measure(params.productName, 18, CW);
  doc.text(productLines, MX, y);
  y += lh(18, productLines.length) + 3;

  font(11, "normal", TEXT_2);
  doc.text(sanitize(`by ${params.brandName}`), MX, y);
  y += 8;

  // Goal with accent bar
  doc.setFillColor(...ACCENT);
  doc.roundedRect(MX, y - 3, 2, 12, 1, 1, "F");
  font(10, "normal", ACCENT_T);
  doc.text(sanitize(params.campaignGoal), MX + 8, y + 4);
  y += 18;

  // ── Gateway Insight Section ───────────────────────────────────────────────

  if (params.gatewayInsight) {
    const gi = params.gatewayInsight;
    const isGateway = gi.currentProductClassification === "Gateway";
    const isConsideration = gi.currentProductClassification === "Consideration";
    const classificationLabel = isGateway ? "GATEWAY PRODUCT" : isConsideration ? "CONSIDERATION PRODUCT" : "HYBRID PRODUCT";
    const formatPrescription = isGateway ? "UGC Video (Product in use)" : isConsideration ? "Carousel or Founder-led Video" : "A/B Test UGC vs Carousel";
    let insightText = "";
    const isCurrentTopGateway = gi.currentProductName === gi.topGatewayName;
    const isCurrentBestseller = gi.currentProductName === gi.bestsellerName;

    if (isCurrentTopGateway && isCurrentBestseller) {
      insightText = `This product is both your organic bestseller and your strongest cold-traffic converter.`;
    } else if (isCurrentTopGateway) {
      insightText = `While your organic bestseller is ${gi.bestsellerName || "another product"}, this product is your true Gateway Product and strongest cold-traffic converter.`;
    } else if (isCurrentBestseller) {
      insightText = `This product is your organic bestseller, but your top Gateway Product for cold traffic is ${gi.topGatewayName || "another product"}.`;
    } else {
      const cls = isGateway ? "Gateway" : isConsideration ? "Consideration" : "Hybrid";
      insightText = `This product is a ${cls} Product. Note that your organic bestseller is ${gi.bestsellerName || "another product"}, and your top Gateway Product is ${gi.topGatewayName || "another product"}.`;
    }

    const gatewayItems: TItem[] = [
      { text: "CLASSIFICATION", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 },
      { text: classificationLabel, size: 11, style: "bold", color: isGateway ? [134, 239, 172] : ACCENT_T, gapAfter: 6 },
      { text: "STRATEGY INSIGHT", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 },
      { text: insightText, size: 10, gapAfter: 6 },
      { text: "CREATIVE DIRECTION", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 },
      { text: `Recommended Format: ${formatPrescription}`, size: 10, style: "bold", gapAfter: 2 },
    ];

    let base64Image = "";
    let imageFormat = "JPEG";

    if (gi.currentProductImage) {
      try {
        const proxyUrl = `/api/media/proxy?url=${encodeURIComponent(gi.currentProductImage)}`;
        const res = await fetch(proxyUrl);
        if (res.ok) {
          const buffer = await res.arrayBuffer();
          // Find format from content type
          const ct = res.headers.get("content-type");
          if (ct?.includes("png")) imageFormat = "PNG";
          // Convert arrayBuffer to base64
          if (typeof Buffer !== "undefined") {
            base64Image = Buffer.from(buffer).toString("base64");
          } else {
            // Browser fallback
            const bytes = new Uint8Array(buffer);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            base64Image = btoa(binary);
          }
        }
      } catch (e) {
        // Ignore fetch errors
      }
    }

    if (base64Image) {
      gatewayItems.push({
        text: "VISUAL ANCHOR", 
        size: 7.5, style: "bold", color: TEXT_3, gapAfter: 4,
        image: base64Image,
        imageFormat,
        imageW: 30,
        imageH: 30
      });
    }

    renderCard("Store Intelligence", gatewayItems);
  }

  // ── Ad Copy Card ────────────────────────────────────────────────────────

  renderCard("Ad Copy", [
    { text: "HEADLINE", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 },
    { text: params.copy.headline, size: 13, style: "bold", color: WHITE, gapAfter: 6 },

    { text: "PRIMARY TEXT", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 },
    { text: params.copy.primaryText, size: 10, gapAfter: 6 },

    { text: "LINK DESCRIPTION", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 },
    { text: params.copy.description, size: 10, gapAfter: 6 },

    { text: "CALL TO ACTION", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 },
    { text: params.copy.cta, size: 11, style: "bold", color: ACCENT_T, gapAfter: 2 },
  ]);

  // ── Copywriter's Note (special styling) ─────────────────────────────────

  const noteItems: TItem[] = [
    { text: `"${params.copy.copywriterNote}"`, size: 9.5, style: "italic", color: TEXT_2, indent: 22, gapAfter: 2 },
  ];
  const noteH = cardH("Copywriter's Note", noteItems);
  ensureSpace(noteH);

  // Subtle different card style — no top accent, dotted feel
  doc.setFillColor(14, 14, 23);
  doc.setDrawColor(...CARD_BD);
  doc.setLineWidth(0.2);
  doc.roundedRect(MX + 8, y, CW - 16, noteH, CR, CR, "FD");

  // Left accent bar
  doc.setFillColor(...ACCENT);
  doc.roundedRect(MX + 8, y + 4, 1.5, noteH - 8, 0.75, 0.75, "F");

  const noteTop = y;
  y += CP;
  font(7.5, "bold", ACCENT_T);
  doc.text("COPYWRITER'S NOTE", MX + 8 + CP, y);
  y += 8;
  font(9.5, "italic", TEXT_2);
  const noteLines = measure(`"${params.copy.copywriterNote}"`, 9.5, CW - 16 - CP * 2 - 6);
  doc.text(noteLines, MX + 8 + CP + 6, y);
  y = noteTop + noteH + 7;

  // ── Targeting Card ──────────────────────────────────────────────────────

  const locations = params.targeting.locations ?? [];
  const interests = params.targeting.interests ?? [];
  const behaviours = params.targeting.behaviours ?? [];
  const ageMin = params.targeting.age_min ?? 0;
  const ageMax = params.targeting.age_max ?? 0;
  const gender = params.targeting.gender ?? "all";

  const targetItems: TItem[] = [];

  // Locations
  targetItems.push({ text: "LOCATIONS", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 });
  const safeLocations = Array.isArray(locations) ? locations : [];
  if (safeLocations.length > 0) {
    targetItems.push({
      text: safeLocations.map(l => `${(l?.name || l?.city || "").split(',')[0].trim()} (${l?.source === "from_data" ? "from orders" : "recommended"})`).filter(Boolean).join("  ·  "),
      size: 10, gapAfter: 6,
    });
  } else {
    targetItems.push({ text: "Set manually in Meta Ads Manager", size: 10, color: TEXT_2, gapAfter: 6 });
  }

  // Age + Gender on one line
  targetItems.push({ text: "DEMOGRAPHICS", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 });
  const ageText = ageMin > 0 && ageMax > 0 ? `${ageMin} — ${ageMax} years` : "25 — 44 (default)";
  const genderText = gender === "all" ? "All genders" : gender === "female" ? "Women" : "Men";
  targetItems.push({ text: `${ageText}  ·  ${genderText}`, size: 10, gapAfter: 2 });
  if (params.targeting.age_reasoning) {
    targetItems.push({ text: params.targeting.age_reasoning, size: 8.5, color: TEXT_3, gapAfter: 6 });
  } else {
    targetItems.push({ text: "", size: 1, gapAfter: 4 }); // spacer
  }

  // Interests
  targetItems.push({ text: "INTERESTS", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 });
  if (interests.length > 0) {
    targetItems.push({ text: interests.join("  ·  "), size: 10, gapAfter: 6 });
  } else {
    targetItems.push({ text: "Add manually based on your niche", size: 10, color: TEXT_2, gapAfter: 6 });
  }

  // Behaviours
  targetItems.push({ text: "BEHAVIOURS", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 });
  if (behaviours.length > 0) {
    targetItems.push({ text: behaviours.join("  ·  "), size: 10, gapAfter: 2 });
  } else {
    targetItems.push({ text: "Engaged Shoppers  ·  Online shoppers", size: 10, gapAfter: 2 });
  }

  renderCard("Audience Targeting", targetItems);

  // ── Budget Card ─────────────────────────────────────────────────────────

  const daily = params.budget.goal_adjusted_daily ?? params.budget.recommended_daily;
  const currency = params.budget.currency || "USD";
  const symbol = params.budget.currency_symbol;
  const duration = params.budget.recommended_duration_days ?? 14;
  const tier = params.budget.tier;
  const adSets = params.budget.ad_sets || 1;

  const budgetItems: TItem[] = [];

  budgetItems.push({ text: "RECOMMENDED DAILY", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 });
  if (daily) {
    budgetItems.push({
      text: `${formatCurrency(daily, currency, symbol)}/day${tier ? `  ·  ${tier} Strategy` : ""}`,
      size: 14, style: "bold", color: WHITE, gapAfter: 2,
    });
    budgetItems.push({
      text: `${duration} days  ·  Total Test Spend: ${formatCurrency(daily * duration, currency, symbol)}`,
      size: 10, color: TEXT_2, gapAfter: 6,
    });
  } else {
    budgetItems.push({
      text: `Set in Meta Ads Manager (${formatCurrency(5000, currency, symbol)}/day recommended)`,
      size: 10, color: TEXT_2, gapAfter: 6,
    });
  }

  // Optimization Event
  if (params.budget.optimization_event) {
    budgetItems.push({ text: "OPTIMIZATION EVENT", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 });
    budgetItems.push({
      text: params.budget.optimization_event.event,
      size: 11, style: "bold", color: ACCENT_T, gapAfter: 2,
    });
    budgetItems.push({
      text: params.budget.optimization_event.reasoning,
      size: 9, color: TEXT_2, gapAfter: 6,
    });
  }

  // Ad Sets
  budgetItems.push({ text: "AD SETS", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 });
  budgetItems.push({
    text: `${adSets} Ad Sets Maximum`,
    size: 10, color: WHITE, gapAfter: 6,
  });

  // Breakdown
  if (params.budget.breakdown) {
    budgetItems.push({ text: "HOW THIS WAS CALCULATED", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 });
    budgetItems.push({
      text: `Revenue signal: ${formatCurrency(params.budget.breakdown.revenue_based, currency, symbol)}/day  ·  AOV signal: ${formatCurrency(params.budget.breakdown.aov_based, currency, symbol)}${params.budget.goal_label ? `  ·  Adjusted for ${params.budget.goal_label}` : ""}`,
      size: 9, color: TEXT_2, gapAfter: 6,
    });
  }

  // Reasoning
  if (params.budget.reasoning) {
    budgetItems.push({ text: "STRATEGY CONTEXT", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 });
    budgetItems.push({ text: params.budget.reasoning, size: 9.5, color: TEXT_2, gapAfter: 2 });
  }

  renderCard("Budget & Strategy", budgetItems);

  // ── Timing Card ─────────────────────────────────────────────────────────

  const peakDays = params.timing.peak_days ?? [];

  if (peakDays.length > 0 || params.timing.launch_recommendation) {
    const timingItems: TItem[] = [];

    if (params.timing.launch_recommendation) {
      timingItems.push({ text: "LAUNCH RECOMMENDATION", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 });
      timingItems.push({ text: params.timing.launch_recommendation, size: 10, gapAfter: 6 });
    }

    if (peakDays.length > 0) {
      timingItems.push({ text: "BEST DAYS TO RUN", size: 7.5, style: "bold", color: TEXT_3, gapAfter: 1 });
      timingItems.push({ text: peakDays.join("  ·  "), size: 10, style: "bold", gapAfter: 2 });
    }

    renderCard("Timing", timingItems);
  }

  // ── Warnings Card ───────────────────────────────────────────────────────

  if (params.warnings.length > 0) {
    const warnItems: TItem[] = params.warnings.map(w => ({
      text: `⚠  ${w}`,
      size: 9.5,
      color: [255, 180, 90] as RGB,
      gapAfter: 4,
    }));
    renderCard("Before You Launch", warnItems);
  }

  // ── Footer on every page ────────────────────────────────────────────────

  const pageCount = (doc.internal as any).pages.length - 1;
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);

    // Footer line
    doc.setDrawColor(...CARD_BD);
    doc.setLineWidth(0.2);
    doc.line(MX, PH - 16, PW - MX, PH - 16);

    // Footer text
    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...TEXT_3);
    doc.text(
      sanitize("Generated by Omni Target  ·  omnitarget.co"),
      PW / 2,
      PH - 11,
      { align: "center" }
    );
    doc.text(`${i} / ${pageCount}`, PW - MX, PH - 11, { align: "right" });
  }

  // ── Save ────────────────────────────────────────────────────────────────

  doc.save(
    `omni-target-brief-${params.productName.replace(/\s+/g, "-").toLowerCase()}.pdf`
  );
}
