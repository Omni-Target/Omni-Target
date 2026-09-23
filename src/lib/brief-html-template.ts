import { fetchSafeImage } from "@/lib/safe-image-fetch";
import { BriefPDFParams, CreativeHook } from "./brief-pdf-types";
import { getCurrencySymbol, formatCurrency } from "./currency";
import {
  isDomesticCity,
  getInternationalBudgetFloor,
  getEffectiveStoreCountry,
  getInternationalStrategies,
  getEstimatedExchangeRate,
  getStoreTimezoneName,
  isTier1Market,
} from "./market-geography";
import { parseBudgetReasoning } from "./campaigns/qualitative-guidance";
import fs from "fs";
import path from "path";

function esc(s: string | undefined | null): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(amount: number, currency: string, symbol?: string): string {
  return formatCurrency(amount, currency, symbol);
}

// ── Inline icon set (stroke = currentColor) ──────────────────────────────────
const ICONS = {
  intel: '<path d="M12 3v1.5M12 19.5V21M4.2 7.5l1.3.75M18.5 15.75l1.3.75M3 12h1.5M19.5 12H21M4.2 16.5l1.3-.75M18.5 8.25l1.3-.75"/><circle cx="12" cy="12" r="3.5"/>',
  copy: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H14l6 6v7.5A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z"/><path d="M14 4v6h6"/><path d="M8.5 13.5h7M8.5 16.5h4"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  hooks: '<path d="M12 2a4 4 0 0 0-4 4v2.5a.5.5 0 0 1-1 0V6a5 5 0 1 1 10 0v2.5a.5.5 0 0 1-1 0V6a4 4 0 0 0-4-4z"/><circle cx="12" cy="15" r="4"/><path d="m14.5 9.5-5 11"/>',
  budget: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6.5 9.5h.01M17.5 14.5h.01"/>',
  timing: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',
  warning: '<path d="M10.3 3.9 2 18.2A2 2 0 0 0 3.7 21h16.6a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4.5M12 17h.01"/>',
  guide: '<path d="M9 4.5h9M9 12h9M9 19.5h9"/><path d="M4 4.2l1.2 1.2 2-2.4M4 11.7l1.2 1.2 2-2.4M4 19.2l1.2 1.2 2-2.4"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  gauge: '<path d="M4 14a8 8 0 0 1 16 0"/><path d="M12 14l3.5-3"/><circle cx="12" cy="14" r="1.2"/>',
  rocket: '<path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2"/><path d="M9 13.5 5.5 12a13 13 0 0 1 9-9l4 .5.5 4a13 13 0 0 1-9 9z"/><circle cx="14.5" cy="9.5" r="1.4"/>',
  tree: '<circle cx="12" cy="4" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M12 6.5v5m0 0L6.8 17m5.2-5.5l5.2 5.5"/>',
} as const;

type Tone = "neutral" | "success" | "info" | "warning";

const TONE: Record<Tone, { fg: string; bg: string; bd: string }> = {
  neutral: { fg: "#09090f", bg: "#f4f4f5", bd: "#e4e4e7" },
  success: { fg: "#15803d", bg: "#f0fdf4", bd: "#c6f0d2" },
  info: { fg: "#4338ca", bg: "#eef2ff", bd: "#c7d2fe" },
  warning: { fg: "#b45309", bg: "#fffaeb", bd: "#fbe6bf" },
};

export const ANGLE_DISPLAY_MAP: Record<string, { label: string; focus: string }> = {
  "Material / Craftsmanship": {
    label: "Craft & Quality",
    focus: "Fabric texture & premium construction",
  },
  "Usability / Transformation": {
    label: "Everyday Fit & Wear",
    focus: "Solves daily dressing hassle & flattering comfort",
  },
  "Contrarian / Curiosity": {
    label: "Why It's Different",
    focus: "Defies convention to capture immediate feed attention",
  },
  "Competitive Differentiation": {
    label: "Why It's Different",
    focus: "Direct comparison, craft origin, and unique edge",
  },
  "Problem / Friction": {
    label: "The Problem Solver",
    focus: "Fixes common frustrations with ordinary options",
  },
  "Identity / Status": {
    label: "Lifestyle & Confidence",
    focus: "Speaks to the buyer's identity and personal aesthetic",
  },
  "Offer / Risk Reversal": {
    label: "Risk-Free Confidence",
    focus: "Removes purchase hesitation and doubt",
  },
};

function tagList(items: string[], tone: Tone = "neutral"): string {
  const t = TONE[tone];
  return items
    .map(
      (i) =>
        `<span class="tag" style="color:${t.fg};background:${t.bg};border-color:${t.bd}">${esc(i)}</span>`
    )
    .join("");
}

function fixPunctuationSpacing(text: string): string {
  if (!text) return "";
  return text
    .replace(/\.(?!(?:com|co|org|net|io|ng|uk|us)\b)([a-zA-Z])/g, ". $1")
    .replace(/,([a-zA-Z])/g, ", $1")
    .replace(/:([a-zA-Z])/g, ": $1")
    .replace(/;([a-zA-Z])/g, "; $1")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/ {2,}/g, " ")
    .trim();
}

function field(label: string, value: string, large = false): string {
  return `<div class="field"><div class="field-label">${esc(label)}</div><div class="field-value${large ? " field-value-lg" : ""}">${value}</div></div>`;
}

function row(label: string, value: string): string {
  return `<div class="row"><span class="row-label">${esc(label)}</span><span class="row-value">${value}</span></div>`;
}

function card(
  label: string,
  content: string,
  icon: string = ICONS.spark,
  tone: Tone = "neutral",
  n?: number,
  extraClass?: string
): string {
  const t = TONE[tone];
  return `
  <section class="card${extraClass ? ` ${extraClass}` : ""}">
    <div class="card-head">
      <span class="card-icon" style="color:${t.fg};background:${t.bg};border-color:${t.bd}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
      </span>
      <span class="card-label">${esc(label)}</span>
      ${n ? `<span class="card-num">${String(n).padStart(2, "0")}</span>` : ""}
    </div>
    <div class="card-body">${content}</div>
  </section>`;
}

function engineLogic(title: string, content: string): string {
  return `
  <div class="engine-logic">
    <div class="engine-logic-head">
      <span class="engine-logic-tag">⚡ OMNI TARGET ENGINE LOGIC</span>
      <span class="engine-logic-title">${esc(title)}</span>
    </div>
    <div class="engine-logic-body">${content}</div>
  </div>`;
}

export async function buildBriefHTML(
  params: BriefPDFParams,
  opts?: { embed?: boolean }
): Promise<string> {
  // Load Inter font weights from disk — guarantees offline rendering.
  const fontsDir = path.join(process.cwd(), "public", "fonts");
  const loadFont = (file: string) => {
    try {
      return fs.readFileSync(path.join(fontsDir, file)).toString("base64");
    } catch {
      return "";
    }
  };
  const inter400 = loadFont("inter-400.woff2");
  const inter600 = loadFont("inter-600.woff2");
  const inter700 = loadFont("inter-700.woff2");
  const inter800 = loadFont("inter-800.woff2");

  let logoDataUri = "";
  try {
    const logoBase64 = fs
      .readFileSync(path.join(process.cwd(), "public", "omni_target_logo.png"))
      .toString("base64");
    logoDataUri = `data:image/png;base64,${logoBase64}`;
  } catch {
    // Missing asset falls back to plain badge
  }
  const logoBadge = logoDataUri
    ? `<img class="logo-badge" src="${logoDataUri}" alt="" />`
    : `<span class="logo-badge"></span>`;

  const fontFaceCSS = [
    inter400 &&
      `@font-face{font-family:'Inter';font-style:normal;font-weight:400;src:url('data:font/woff2;base64,${inter400}') format('woff2');}`,
    inter600 &&
      `@font-face{font-family:'Inter';font-style:normal;font-weight:600;src:url('data:font/woff2;base64,${inter600}') format('woff2');}`,
    inter700 &&
      `@font-face{font-family:'Inter';font-style:normal;font-weight:700;src:url('data:font/woff2;base64,${inter700}') format('woff2');}`,
    inter800 &&
      `@font-face{font-family:'Inter';font-style:normal;font-weight:800;src:url('data:font/woff2;base64,${inter800}') format('woff2');}`,
  ]
    .filter(Boolean)
    .join("\n  ");

  // ── Data extraction ──
  const gi = params.gatewayInsight ?? null;
  const budget = params.budget ?? ({} as BriefPDFParams["budget"]);
  const copy = params.copy ?? ({} as BriefPDFParams["copy"]);
  const timing = params.timing ?? ({} as BriefPDFParams["timing"]);
  const guidance = params.advantage_plus_guidance;
  const seed = guidance?.seed_audience_suggestions;
  const legacyTargeting = params.targeting ?? {};
  const overseasDemand = legacyTargeting.overseas_demand || [];

  const currency = budget.currency || "USD";
  const symbol = budget.currency_symbol || getCurrencySymbol(currency);
  const daily = budget.goal_adjusted_daily ?? budget.recommended_daily ?? null;
  const duration = budget.recommended_duration_days ?? 14;
  const intlDuration = budget.international_duration_days ?? duration;

  const campaignType =
    guidance?.campaign_type ?? "Manual Sales with Advantage+ Audience";
  const optimizationEvent =
    guidance?.optimization_event ??
    budget.optimization_event?.event ??
    "Purchase";
  const optimizationReasoning =
    guidance?.optimization_reasoning ??
    budget.optimization_event?.reasoning ??
    "";

  const effectiveStoreCountry = getEffectiveStoreCountry(params.storeCountry, currency);

  const rawLocations = Array.isArray(legacyTargeting.locations)
    ? legacyTargeting.locations
    : [];

  const isDomLoc = (l: { name?: string; city?: string; country?: string; market_type?: string }) => {
    if (l?.market_type === "international") return false;
    return isDomesticCity(l?.name || l?.city || "", l?.country, effectiveStoreCountry, currency);
  };

  const rawDomestic = (
    legacyTargeting.domestic_locations && legacyTargeting.domestic_locations.length > 0
      ? legacyTargeting.domestic_locations
      : rawLocations
  ).filter(isDomLoc);

  const rawIntl = (
    legacyTargeting.international_locations &&
    legacyTargeting.international_locations.length > 0
      ? legacyTargeting.international_locations
      : rawLocations
  ).filter((l) => !isDomLoc(l));

  const isTier1 = isTier1Market(effectiveStoreCountry, currency);
  const isUS = effectiveStoreCountry.toLowerCase().includes("united states");
  const hasOverseasOrders =
    overseasDemand.length > 0 ||
    legacyTargeting.international_locations?.some((l) => l.source === "from_data") ||
    rawLocations.some((l) => !isDomLoc(l) && (l as { source?: string }).source === "from_data");

  const showOverseas = isTier1 ? hasOverseasOrders : true;
  const domesticLocs = rawDomestic.length > 0 ? rawDomestic : rawLocations;
  const intlLocs =
    !showOverseas
      ? []
      : rawIntl.length > 0
      ? rawIntl
      : overseasDemand
          .filter((name) => !isDomesticCity(name, undefined, effectiveStoreCountry, currency))
          .map((name) => ({
            name,
            source: "from_data" as const,
          }));

  const domesticBudgetStr =
    legacyTargeting.domestic_budget_formatted ||
    (daily ? `${formatCurrency(daily, currency, symbol)}/day` : "");

  const intlStrategies = getInternationalStrategies(currency, undefined, daily ?? undefined);
  const intlDaily =
    budget.international_daily ||
    intlStrategies[1]?.daily;
  const intlTier =
    budget.international_tier ||
    intlStrategies[1]?.label ||
    "Sweet Spot";

  const intlBudgetStr =
    budget.international_budget_formatted ||
    legacyTargeting.international_budget_formatted ||
    (intlDaily ? `${formatCurrency(intlDaily, currency, symbol)}/day` : "") ||
    getInternationalBudgetFloor(currency);

  const seedInterests =
    seed?.seed_interests ??
    (Array.isArray(legacyTargeting.interests)
      ? legacyTargeting.interests
      : []);
  const ageMin = seed?.age_min ?? legacyTargeting.age_min ?? 25;
  const ageMax = seed?.age_max ?? legacyTargeting.age_max ?? 44;
  const genderLabel =
    seed?.gender ??
    (legacyTargeting.gender === "female"
      ? "Women"
      : legacyTargeting.gender === "male"
      ? "Men"
      : "All");
  const numProductPrice =
    typeof params.productPrice === "number"
      ? params.productPrice
      : params.productPrice
      ? parseFloat(String(params.productPrice).replace(/[^0-9.]/g, ""))
      : 0;

  const decisionEvidence = params.decisionEvidence;
  const recentFunnel = guidance?.event_evidence?.recent_funnel ?? decisionEvidence?.recent_funnel;
  const recentFunnelSummary = recentFunnel?.cart_sessions !== null &&
    recentFunnel?.cart_sessions !== undefined &&
    recentFunnel.checkout_sessions !== null &&
    recentFunnel.completed_checkout_sessions !== null
      ? `Shopify ${recentFunnel.window_days}-day sessions: ${recentFunnel.cart_sessions} cart additions, ${recentFunnel.checkout_sessions} reached checkout, ${recentFunnel.completed_checkout_sessions} completed checkout`
      : "Strong interest: shoppers adding to cart, but drop-offs before checkout";

  const hooks: CreativeHook[] = params.creative_hooks ?? [];
  const peakDays: string[] = Array.isArray(timing.peak_days)
    ? timing.peak_days
    : [];
  const storeTimezoneName = getStoreTimezoneName(effectiveStoreCountry, currency);
  const launchDayName = peakDays[0];
  const preciseLaunchTiming = launchDayName ? `${launchDayName}, 12:00 AM (${storeTimezoneName})` : "When your store and creative are ready";

  // ── Product image as base64 ──
  let productImgSrc = "";
  if (gi?.currentProductImage) {
    try {
      const res = await fetchSafeImage(gi.currentProductImage);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const ct = res.headers.get("content-type") || "image/jpeg";
        productImgSrc = `data:${ct};base64,${Buffer.from(buf).toString(
          "base64"
        )}`;
      }
    } catch {
      /* ignore */
    }
  }

  // ── Store Intelligence & Product Strategy content ──
  let gatewayCardHTML = "";
  if (gi) {
    const hasSalesData = Boolean(
      (gi.firstTimeBuyerRatio !== undefined && gi.firstTimeBuyerRatio > 0) ||
      (gi.unitsSold && gi.unitsSold > 0) ||
      (gi.uniqueCustomerCount && gi.uniqueCustomerCount > 0)
    );
    const isNew =
      params.isNewLaunch ||
      (!hasSalesData &&
        (gi.currentProductClassification === "Insufficient Data" ||
          gi.currentProductClassification === "Unknown" ||
          !gi.currentProductClassification));

    const isGateway = gi.currentProductClassification === "Gateway";
    const isConsideration = gi.currentProductClassification === "Consideration";

    const decision = gi.productDecision;
    const classTone: Tone = decision?.test_readiness === "hold" ? "warning" : isGateway ? "info" : isConsideration ? "warning" : "neutral";
    const classLabel = isGateway
      ? decision?.role_confidence === "directional" ? "Possible First-Order Gateway" : "First-Order Gateway Signal"
      : isConsideration
      ? decision ? "Later-Order Signal" : "Repeat Favorite"
      : isNew
      ? "New Arrival"
      : "All-Round Seller";

    const formatPrescription = isGateway
      ? "Try a 9:16 vertical video (Instagram Reels & Stories) showing the product in motion on a real person, paired with a clean square photo for feed placements."
      : isConsideration
      ? "Try a photo carousel showing close-up details, styling options, and craftsmanship."
      : "Try a 9:16 vertical video (Instagram Reels & Stories) alongside a clean square photo to see which creative brings more sales.";

    let insightText = "";
    if (decision && !params.isNewLaunch && !isNew) {
      insightText = `${decision.role_reason} ${decision.test_readiness === "hold" ? "Hold the ad test until stock returns." : decision.test_readiness === "review" ? "Review inventory and recorded costs before testing." : "This is a planning candidate; check shipping, fees and returns before setting an affordable acquisition cost."}`;
    } else if (params.isNewLaunch || isNew) {
      insightText =
        "New product launch — great for testing customer interest with Meta's audience discovery.";
    } else if (
      gi.currentProductName === gi.topGatewayName &&
      gi.currentProductName === gi.bestsellerName
    ) {
      insightText =
        "This product is both your overall bestseller and the item that appeared most often in new shoppers' first orders.";
    } else if (gi.currentProductName === gi.topGatewayName) {
      insightText = `While your overall store bestseller is ${
        gi.bestsellerName || "another product"
      }, this product appeared most often in new buyers' first orders, making it your highest-signal candidate for winning cold shoppers on Meta.`;
    } else if (gi.currentProductName === gi.bestsellerName) {
      insightText = `This is your store's top revenue earner, with strong natural demand and steady sales.`;
    } else if (isGateway) {
      insightText =
        "First-order magnet — this piece appeared frequently in new shoppers' first purchases.";
    } else if (isConsideration) {
      insightText =
        "Repeat favorite — this product is frequently purchased by returning shoppers after discovering your brand.";
    } else {
      insightText =
        "Reliable seller that appeals equally to brand-new shoppers and repeat customers.";
    }

    let evidenceHTML = "";
    if (decision && !params.isNewLaunch && !isNew) {
      const followUp = decision.follow_up_60d;
      evidenceHTML = `
        <div style="margin-top:12px; margin-bottom:12px; padding:12px 14px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; font-size:11.5px; color:#166534;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; padding-bottom:6px; border-bottom:1px solid #dcfce7;">
            <div style="display:flex; align-items:center; gap:6px; font-weight:700; color:#15803d; font-size:12px;">
              <span>✓</span>
              <span>Verified First-Order Magnet</span>
            </div>
            <span style="font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; background:#dcfce7; color:#166534; padding:2px 7px; border-radius:999px;">
              ${esc(decision.role_confidence)} Signal
            </span>
          </div>
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px; margin-bottom:8px;">
            <div>
              <div style="font-size:10px; font-weight:600; text-transform:uppercase; color:#15803d; letter-spacing:0.03em;">First-Order Volume</div>
              <div style="font-weight:700; font-size:13px; color:#14532d; margin-top:2px;">
                ${decision.first_order_count} of ${decision.identified_first_orders} identified first orders
              </div>
              <div style="font-size:10.5px; color:#166534; margin-top:1px;">
                vs ${decision.later_order_count} repeat orders
              </div>
            </div>
            <div>
              <div style="font-size:10px; font-weight:600; text-transform:uppercase; color:#15803d; letter-spacing:0.03em;">60-Day Repeat LTV</div>
              <div style="font-weight:700; font-size:13px; color:#14532d; margin-top:2px;">
                ${followUp.repeat_rate === null ? "Building Cohort" : `${Math.round(followUp.repeat_rate * 100)}% reorder rate`}
              </div>
              <div style="font-size:10.5px; color:#166534; margin-top:1px;">
                ${followUp.repeat_rate === null ? "New product" : `${followUp.buyers_with_another_order} of ${followUp.eligible_first_order_buyers} buyers placed another store order`}
              </div>
            </div>
            <div>
              <div style="font-size:10px; font-weight:600; text-transform:uppercase; color:#15803d; letter-spacing:0.03em;">Test Readiness</div>
              <div style="font-weight:700; font-size:13px; color:#14532d; margin-top:2px; text-transform:capitalize;">
                ${esc(decision.test_readiness.replaceAll("_", " "))}
              </div>
              <div style="font-size:10.5px; color:#166534; margin-top:1px;">
                ${esc(decision.readiness_reasons[0] || "Stock verified")}
              </div>
            </div>
          </div>
          <div style="font-size:10px; color:#15803d; border-top:1px solid #dcfce7; padding-top:5px; opacity:0.85;">
            Source: Shopify accessible paid orders and catalog, synced ${esc(decision.as_of.slice(0, 10))}. ${esc(decision.limitations.join(" "))}
          </div>
        </div>`;
    } else if (params.isNewLaunch || isNew) {
      evidenceHTML = `
        <div style="margin-top:8px; margin-bottom:10px; padding:7px 11px; background:#eef2ff; border:1px solid #c7d2fe; border-left:3px solid #6366f1; border-radius:6px; font-size:11px; color:#3730a3; line-height:1.5;">
          <strong style="color:#4f46e5; font-weight:700;">✨ New arrival test:</strong> Fresh in your catalog — optimized to introduce new shoppers to your brand.
        </div>`;
    } else if (gi.firstTimeBuyerRatio !== undefined && gi.firstTimeBuyerRatio > 0) {
      const ftbPct = Math.round(gi.firstTimeBuyerRatio * 100);
      const totalCust = gi.uniqueCustomerCount ?? gi.unitsSold ?? gi.orderCount;
      const ftbCount =
        gi.firstTimeBuyerCount ??
        (totalCust && gi.firstTimeBuyerRatio ? Math.round(totalCust * gi.firstTimeBuyerRatio) : undefined);

      const detailStr =
        ftbCount && totalCust
          ? `${ftbCount} of ${totalCust} unique customers (${ftbPct}%) who purchased this item were first-time customers of your store (based on accessible paid-order history).`
          : `${ftbPct}% of customers who purchased this item were first-time customers of your store (based on accessible paid-order history).`;

      evidenceHTML = `
        <div style="margin-top:8px; margin-bottom:10px; padding:7px 11px; background:#f0fdf4; border:1px solid #bbf7d0; border-left:3px solid #16a34a; border-radius:6px; font-size:11px; color:#166534; line-height:1.5;">
          <strong style="color:#15803d; font-weight:700;">✓ Strong first-purchase signal:</strong> ${detailStr}
        </div>`;
    } else if (gi.unitsSold && gi.unitsSold > 0) {
      evidenceHTML = `
        <div style="margin-top:8px; margin-bottom:10px; padding:7px 11px; background:#f0fdf4; border:1px solid #bbf7d0; border-left:3px solid #16a34a; border-radius:6px; font-size:11px; color:#166534; line-height:1.5;">
          <strong style="color:#15803d; font-weight:700;">✓ Proven seller:</strong> ${gi.unitsSold} orders recorded in your Shopify store.
        </div>`;
    } else if (isGateway) {
      evidenceHTML = `
        <div style="margin-top:8px; margin-bottom:10px; padding:7px 11px; background:#f0fdf4; border:1px solid #bbf7d0; border-left:3px solid #16a34a; border-radius:6px; font-size:11px; color:#166534; line-height:1.5;">
          <strong style="color:#15803d; font-weight:700;">✓ Gateway product:</strong> This product is your top customer acquisition magnet for attracting first-time shoppers.
        </div>`;
    }

    const ct = TONE[classTone] || TONE.neutral;
    gatewayCardHTML = card(
      "Product strategy & best formats",
      `
      <div class="intel">
        <div class="intel-main">
          <div style="margin-bottom:6px;">
            <span class="pill" style="color:${ct.fg};background:${ct.bg};border-color:${ct.bd}">${esc(
        classLabel
      )}</span>
          </div>
          ${evidenceHTML}
          ${field(
            "Strategy overview",
            `<p class="prose">${esc(insightText)}</p>`
          )}
          <div class="callout callout-info">
            <div class="callout-label">Best ad formats</div>
            <p>${esc(formatPrescription)}</p>
          </div>
        </div>
        ${
          productImgSrc
            ? `<div class="intel-img"><img src="${productImgSrc}" alt="Product"/></div>`
            : ""
        }
      </div>`,
      ICONS.intel,
      "neutral",
      1,
      "page-break-before"
    );
  }

  // ── Executive Campaign Flight Deck (Page 1 Control Panel) ──
  const primaryDomesticStr =
    domesticLocs
      .map((l: { name?: string; city?: string }) => (l?.name || l?.city || "").split(",")[0].trim())
      .filter(Boolean)
      .join(", ") || "Nationwide Broad";

  const audienceDisplay =
    genderLabel === "Women"
      ? `Women · Ages ${ageMin}–${ageMax}`
      : genderLabel === "Men"
      ? `Men · Ages ${ageMin}–${ageMax}`
      : `Men & Women · Ages ${ageMin}–${ageMax}`;

  const actualAngleLabels =
    hooks && hooks.length > 0
      ? hooks
          .slice(0, 3)
          .map((h) => ANGLE_DISPLAY_MAP[h.angle]?.label || h.angle)
          .filter(Boolean)
      : ["Craft & Quality", "The Problem Solver", "Everyday Fit & Wear"];
  const angleSummaryStr = `${actualAngleLabels.length} Angles (${actualAngleLabels.join(", ")})`;

  const summaryHTML = `
  <section class="flight-deck">
    <div class="flight-deck-head">
      <div class="flight-deck-title">
        <span class="flight-deck-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS.gauge}</svg></span>
        <span>Meta Ads Manager Launch Control Panel</span>
      </div>
      <span class="flight-deck-badge">Fast 3-Minute Setup</span>
    </div>

    <div class="flight-metric-grid">
      <div class="flight-metric">
        <div class="flight-metric-val">${daily ? fmt(daily, currency, symbol) : "Set manually"}<span class="flight-metric-unit">/day</span></div>
        <div class="flight-metric-label">${showOverseas && intlDaily ? "Primary Local Daily" : "Recommended Daily Budget"}</div>
        <div class="flight-metric-sub">${esc(budget.tier || "Sweet Spot")} Strategy · 1 Ad Set</div>
      </div>
      <div class="flight-metric">
        <div class="flight-metric-val">${esc(optimizationEvent === "AddToCart" ? "Add to Cart" : optimizationEvent === "InitiateCheckout" ? "Initiate Checkout" : optimizationEvent)}</div>
        <div class="flight-metric-label">What to Optimize For</div>
        <div class="flight-metric-sub">${optimizationEvent === "AddToCart" ? "Suggested starting goal" : optimizationEvent === "InitiateCheckout" ? "High-intent checkout starts" : "Direct customer orders"}</div>
      </div>
      <div class="flight-metric">
        <div class="flight-metric-val flight-sku" title="${esc(params.productName)}">${esc(params.productName)}</div>
        <div class="flight-metric-label">Featured Product</div>
        <div class="flight-metric-sub">${params.productPrice && params.productPrice > 0 ? `Unit Price: ${fmt(params.productPrice, currency, symbol)}` : "Store catalog focus"}</div>
      </div>
      <div class="flight-metric">
        <div class="flight-metric-val">${campaignType.includes("ASC") ? "Advantage+ (ASC)" : "Manual Sales (AI Guided)"}</div>
        <div class="flight-metric-label">Campaign Type</div>
        <div class="flight-metric-sub">${campaignType.includes("ASC") ? "Automated Shopping Campaign" : "Targeted Audience Setup"}</div>
      </div>
    </div>
    ${
      showOverseas && intlDaily
        ? `<div class="flight-reconcile-bar" style="margin-top:10px; padding:8px 12px; border-radius:8px; background:#f8fafc; border:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; font-size:11px; flex-wrap:wrap; gap:6px;">
      <div>
        <span style="font-weight:700; color:#0f172a;">Independent Ad Set Budgets:</span>
        <span style="color:#16a34a; font-weight:700; margin-left:6px;">Primary Local:</span> ${daily ? fmt(daily, currency, symbol) : "—"}/day (${esc(budget.tier || "Sweet Spot")})
        <span style="color:#94a3b8; margin:0 4px;">·</span>
        <span style="color:#6366f1; font-weight:700;">Optional Overseas:</span> ${fmt(intlDaily, currency, symbol)}/day (${esc(intlTier || budget.international_tier || "Sweet Spot")})
      </div>
      <div style="font-weight:700; color:#334155;">
        Combined Total: <span style="color:#0f172a; font-weight:800;">${fmt((daily || 0) + intlDaily, currency, symbol)}/day</span> (${duration === intlDuration ? `${duration}d: ` : `Local ${duration}d + Overseas ${intlDuration}d: `}${fmt((daily ? daily * duration : 0) + intlDaily * intlDuration, currency, symbol)})
      </div>
    </div>`
        : ""
    }
    <div style="margin-top:10px; padding:9px 12px; border-radius:8px; background:#fffaeb; border:1px solid #fbe6bf; color:#92400e; font-size:11px; line-height:1.45;">
      <strong>Before publishing:</strong> Confirm that ${esc(optimizationEvent === "AddToCart" ? "Add to Cart" : optimizationEvent === "InitiateCheckout" ? "Initiate Checkout" : optimizationEvent)} is active and receiving recent website events in Meta Events Manager. Shopify sessions do not verify Meta event health.
    </div>

    <div class="cheat-sheet">
      <div class="cheat-sheet-head">Settings to Copy into Meta Ads Manager</div>
      <div class="cheat-sheet-grid">
        <div class="cheat-cell">
          <span class="cheat-label">Campaign Objective</span>
          <span class="cheat-val">Sales · ${campaignType.includes("ASC") ? "Advantage+ Shopping Campaign (ASC)" : "Manual Sales with Advantage+ Audience"}</span>
        </div>
        <div class="cheat-cell">
          <span class="cheat-label">Conversion Goal &amp; Location</span>
          <span class="cheat-val">${esc(optimizationEvent === "AddToCart" ? "Add to Cart" : optimizationEvent === "InitiateCheckout" ? "Initiate Checkout" : optimizationEvent)} · Website</span>
        </div>
        <div class="cheat-cell">
          <span class="cheat-label">Target Audience (Age &amp; Gender)</span>
          <span class="cheat-val">${esc(audienceDisplay)}</span>
        </div>
        <div class="cheat-cell">
          <span class="cheat-label">Target Cities (Local)</span>
          <span class="cheat-val">${esc(primaryDomesticStr)}</span>
        </div>
        <div class="cheat-cell">
          <span class="cheat-label">Test Duration &amp; Total Spend</span>
          <span class="cheat-val">${
            showOverseas && intlDaily
              ? `Local: ${duration}d (${daily ? fmt(daily * duration, currency, symbol) : "—"}) · Overseas: ${intlDuration}d (${fmt(intlDaily * intlDuration, currency, symbol)}) · Total: ${fmt((daily ? daily * duration : 0) + intlDaily * intlDuration, currency, symbol)}`
              : `${duration} Days · Total ${daily ? fmt(daily * duration, currency, symbol) : "—"}`
          }</span>
        </div>
        <div class="cheat-cell">
          <span class="cheat-label">Best Time to Launch</span>
          <span class="cheat-val">${esc(preciseLaunchTiming)}</span>
        </div>
        <div class="cheat-cell">
          <span class="cheat-label">Ad Creatives to Upload</span>
          <span class="cheat-val">${esc(angleSummaryStr)}</span>
        </div>
        <div class="cheat-cell">
          <span class="cheat-label">Where Ads Appear (Placements)</span>
          <span class="cheat-val">Advantage+ Automatic (Instagram Reels, Stories &amp; Feed)</span>
        </div>
      </div>
    </div>
  </section>`;

  // ── Ad Copy (Card 2) ──
  const cleanHeadline = fixPunctuationSpacing(copy.headline);
  const cleanPrimaryText = fixPunctuationSpacing(copy.primaryText);
  const cleanDescription = fixPunctuationSpacing(copy.description);
  const cleanCopywriterNote = fixPunctuationSpacing(copy.copywriterNote);

  const adCopyHTML = card(
    "Copy-paste ready ad assets",
    `
    <p class="section-intro" style="margin-bottom:12px;">Click or drag across any clipping card below to copy clean text directly into Meta Ads Manager.</p>
    
    <div class="clip-card">
      <div class="clip-head">
        <span class="clip-tag">✂ COPY FOR META: PRIMARY TEXT</span>
      </div>
      <div class="clip-body clip-selectable">${esc(cleanPrimaryText)}</div>
    </div>

    <div class="clip-card">
      <div class="clip-head">
        <span class="clip-tag">✂ COPY FOR META: HEADLINE</span>
      </div>
      <div class="clip-body clip-selectable headline">${esc(cleanHeadline)}</div>
    </div>

    <div class="clip-row">
      <div class="clip-card" style="flex: 2;">
        <div class="clip-head">
          <span class="clip-tag">✂ COPY FOR META: LINK DESCRIPTION</span>
        </div>
        <div class="clip-body clip-selectable muted-prose">${esc(cleanDescription)}</div>
      </div>
      <div class="clip-card" style="flex: 1;">
        <div class="clip-head">
          <span class="clip-tag">🎯 META BUTTON: CALL TO ACTION</span>
        </div>
        <div class="clip-body" style="padding-top:4px;">
          <span class="cta-badge">${esc(copy.cta)}</span>
        </div>
      </div>
    </div>`,
    ICONS.copy,
    "neutral",
    2
  );

  // ── Copywriter's Strategic Positioning ──
  const noteHTML = cleanCopywriterNote
    ? engineLogic(
        "Creative Hook Strategy & Positioning",
        `<p>${esc(cleanCopywriterNote)}</p>`
      )
    : "";

  // ── Creative Hooks (Card 3) ──
  let creativeHooksHTML = "";
  if (hooks.length > 0) {
    const hooksCards = hooks
      .slice(0, 3)
      .map(
        (h, i) => {
          const display = ANGLE_DISPLAY_MAP[h.angle] || {
            label: h.angle,
            focus: "Proven Advantage+ creative angle",
          };
          return `
      <div class="hook-box">
        <div class="hook-head">
          <span class="hook-number">${i + 1}</span>
          <div style="display:flex; flex-direction:column;">
            <span class="hook-angle">${esc(display.label)}</span>
            <span style="font-size:10px; color:#6b7280; font-weight:normal; margin-top:1px;">${esc(display.focus)}</span>
          </div>
        </div>
        <div class="hook-body">
          <div class="hook-row">
            <span class="hook-label">What to film</span>
            <span class="hook-val">${esc(fixPunctuationSpacing(h.visual_cue))}</span>
          </div>
          <div class="hook-row">
            <span class="hook-label">Text on screen</span>
            <span class="hook-val hook-overlay">&ldquo;${esc(
              fixPunctuationSpacing(h.on_screen_text)
            )}&rdquo;</span>
          </div>
          <div class="hook-row">
            <span class="hook-label">First 3 seconds</span>
            <span class="hook-val hook-opening">&ldquo;${esc(
              fixPunctuationSpacing(h.primary_text_hook)
            )}&rdquo;</span>
          </div>
        </div>
      </div>`;
        }
      )
      .join("");

    creativeHooksHTML = card(
      "3 Creative angles to test",
      `<p class="section-intro">3 distinct creative angles tailored to your product's appeal and customer motivations. Test each angle in your campaign to discover which resonates best with your audience.</p>
      ${noteHTML ? `<div style="margin-bottom:12px;">${noteHTML}</div>` : ""}
      <div class="hooks-grid">${hooksCards}</div>`,
      ICONS.hooks,
      "neutral",
      3,
      "page-break-before"
    );
  }

  // ── Target Audience & Campaign Settings (Card 4) ──
  const cleanOptimizationReasoning = fixPunctuationSpacing(optimizationReasoning);

  type LocItem = { source?: string; name?: string; city?: string };

  const provenDomesticLocs = domesticLocs.filter(
    (l: LocItem) => l?.source === "from_data"
  );
  const recommendedDomesticLocs = domesticLocs.filter(
    (l: LocItem) => l?.source !== "from_data"
  );

  let domesticLocationMarkup = "";
  if (provenDomesticLocs.length > 0 && recommendedDomesticLocs.length > 0) {
    domesticLocationMarkup = `
      <div style="margin-bottom:8px;">
        <div style="font-size:10.5px; font-weight:700; color:#15803d; margin-bottom:4px; text-transform:uppercase; letter-spacing:0.04em;">
          ✓ Proven by past store orders
        </div>
        ${tagList(
          provenDomesticLocs
            .map((l: LocItem) => (l?.name || l?.city || "").split(",")[0].trim())
            .filter(Boolean),
          "success"
        )}
        <div style="font-size:11px; color:#15803d; margin-top:4px; font-weight:500;">
          Based on past customer shipments in your Shopify store.
        </div>
      </div>
      <div>
        <div style="font-size:10.5px; font-weight:700; color:#475569; margin-bottom:4px; text-transform:uppercase; letter-spacing:0.04em;">
          💡 Suggested regional hubs (AI recommendation)
        </div>
        ${tagList(
          recommendedDomesticLocs
            .map((l: LocItem) => (l?.name || l?.city || "").split(",")[0].trim())
            .filter(Boolean)
        )}
        <div style="font-size:11px; color:#475569; margin-top:4px; line-height:1.45;">
          Commercial centers to test based on urban reach and delivery access. A suggested starting hypothesis to test alongside your proven customer locations.
        </div>
      </div>
    `;
  } else if (provenDomesticLocs.length > 0) {
    domesticLocationMarkup = `
      ${tagList(
        provenDomesticLocs
          .map((l: LocItem) => (l?.name || l?.city || "").split(",")[0].trim())
          .filter(Boolean),
        "success"
      )}
      <div style="font-size:11px; color:#15803d; margin-top:5px; font-weight:500;">
        <span>✓</span> <strong>Proven by past store orders:</strong> Based on past customer shipments in your Shopify store.
      </div>
    `;
  } else if (recommendedDomesticLocs.length > 0) {
    domesticLocationMarkup = `
      ${tagList(
        recommendedDomesticLocs
          .map((l: LocItem) => (l?.name || l?.city || "").split(",")[0].trim())
          .filter(Boolean)
      )}
      <div style="font-size:11px; color:#475569; margin-top:5px; line-height:1.45;">
        <span>💡</span> <span><strong>Suggested regional hubs (AI recommendation):</strong> Commercial centers to test based on urban reach and delivery access. A starting hypothesis to test alongside your proven customer locations.</span>
      </div>
    `;
  }

  const provenIntlLocs = intlLocs.filter(
    (l: LocItem) => l?.source === "from_data"
  );
  const recommendedIntlLocs = intlLocs.filter(
    (l: LocItem) => l?.source !== "from_data"
  );

  let intlLocationMarkup = "";
  if (provenIntlLocs.length > 0 && recommendedIntlLocs.length > 0) {
    intlLocationMarkup = `
      <div style="margin-bottom:8px;">
        <div style="font-size:10.5px; font-weight:700; color:#15803d; margin-bottom:4px; text-transform:uppercase; letter-spacing:0.04em;">
          ✓ Proven by past store orders
        </div>
        ${tagList(
          provenIntlLocs
            .map((l: LocItem) => (l?.name || l?.city || "").split(",")[0].trim())
            .filter(Boolean),
          "success"
        )}
        <div style="font-size:11px; color:#15803d; margin-top:4px; font-weight:500;">
          Based on past customer shipments in your Shopify store.
        </div>
      </div>
      <div>
        <div style="font-size:10.5px; font-weight:700; color:#4338ca; margin-bottom:4px; text-transform:uppercase; letter-spacing:0.04em;">
          💡 Suggested expansion markets (AI recommendation)
        </div>
        ${tagList(
          recommendedIntlLocs
            .map((l: LocItem) => (l?.name || l?.city || "").split(",")[0].trim())
            .filter(Boolean)
        )}
        <div style="font-size:11px; color:#4338ca; margin-top:4px; line-height:1.45;">
          Major international commercial and diaspora centers. You haven't shipped there yet — win your home market first before testing overseas.
        </div>
      </div>
    `;
  } else if (provenIntlLocs.length > 0) {
    intlLocationMarkup = `
      ${tagList(
        provenIntlLocs
          .map((l: LocItem) => (l?.name || l?.city || "").split(",")[0].trim())
          .filter(Boolean),
        "success"
      )}
      <div style="font-size:11px; color:#15803d; margin-top:5px; font-weight:500;">
        <span>✓</span> <strong>Proven by past store orders:</strong> Based on past customer shipments in your Shopify store.
      </div>
    `;
  } else if (recommendedIntlLocs.length > 0) {
    intlLocationMarkup = `
      ${tagList(
        recommendedIntlLocs
          .map((l: LocItem) => (l?.name || l?.city || "").split(",")[0].trim())
          .filter(Boolean)
      )}
      <div style="font-size:11px; color:#4338ca; margin-top:5px; line-height:1.45;">
        <span>💡</span> <span><strong>Suggested expansion markets (AI recommendation):</strong> Major international commercial and diaspora centers. You haven't shipped there yet — win your home market first before testing overseas.</span>
      </div>
    `;
  }

  const audienceHTML = card(
    "Target audience & locations",
    `
    ${engineLogic(
      `Optimization Goal · ${optimizationEvent === "AddToCart" ? "Add to Cart" : optimizationEvent}`,
      `<p><strong>Why this goal:</strong> ${esc(cleanOptimizationReasoning || "Purchase is the sales-goal hypothesis. Verify the selected website event in Meta Events Manager before publishing; Shopify order counts do not establish Meta event volume.")}</p>
       ${
         optimizationEvent === "AddToCart"
           ? `<p style="margin-top:8px; color:#fde68a;"><strong>💡 Quality Check:</strong> Compare observed cart, checkout and completed-checkout sessions during the test. A cart addition alone is not a purchase; review delivery fees, payment issues, sizing and return-policy clarity before changing the event.</p>`
           : ""
       }`
    )}

    ${field(
      isTier1 && isUS ? "Where to run ads (Advantage+ Audience)" : "Where to run ads (Local)",
      isTier1 && isUS
        ? `${tagList(["United States (Nationwide)"], "success")}${
            domesticLocationMarkup
              ? `<div style="margin-top:8px;">${domesticLocationMarkup}</div>`
              : ""
          }${
            domesticBudgetStr
              ? `<div style="font-size:11px; color:#4b5563; margin-top:6px;"><strong>Daily budget:</strong> ${esc(
                  domesticBudgetStr
                )} — run as 1 ad set to let Meta find buyers without splitting your spend</div>`
              : ""
          }`
        : domesticLocs.length > 0
        ? `${domesticLocationMarkup}${
            domesticBudgetStr
              ? `<div style="font-size:11px; color:#4b5563; margin-top:6px;"><strong>Daily budget:</strong> ${esc(
                  domesticBudgetStr
                )} — run as 1 ad set to keep your local spend focused</div>`
              : ""
          }`
        : `<span class="muted">Set manually in Meta Ads Manager</span>`
    )}

    ${
      intlLocs.length > 0
        ? field(
            "🌍 International locations to consider (Optional)",
            `${intlLocationMarkup}${
              intlBudgetStr
                ? `<div style="font-size:11px; color:#4338ca; margin-top:6px;"><strong>Optional overseas budget:</strong> ${esc(
                    intlBudgetStr
                  )} (${esc(intlTier)} Strategy) — ${
                    isTier1
                      ? "run as a separate campaign only when you want to explore overseas buyers without diluting your domestic ad delivery or complicating fulfillment."
                      : "run as a separate campaign only when you want to explore overseas buyers without diluting your local budget."
                  }</div>`
                : ""
            }`
          )
        : ""
    }

    <div class="two-col">
      ${field(
        "Suggested starting age",
        `<span class="stat-inline">${ageMin}–${ageMax}</span>`
      )}
      ${field("Suggested gender", `<span class="stat-inline">${genderLabel === "All" ? "Men & Women" : genderLabel}</span>`)}
    </div>
    <div style="font-size:10px; color:#475569; margin-top:4px; line-height:1.45; background:#f8fafc; border-left:3px solid #cbd5e1; padding:5px 8px; border-radius:4px;">
      <span style="font-weight:600; color:#334155;">💡 Suggested starting age:</span>
      Shopify does not track customer age. We recommend ${ageMin}–${ageMax} as an initial test range based on your product price point, giving Meta a clean starting window while its algorithm learns from live delivery.
    </div>

    ${field(
      "Suggested interests (Starting hints)",
      seedInterests.length > 0
        ? `${tagList(seedInterests)}
           <div style="font-size:10px; color:#475569; margin-top:4px; line-height:1.45; background:#f8fafc; border-left:3px solid #cbd5e1; padding:5px 8px; border-radius:4px;">
             <span style="font-weight:600; color:#334155;">💡 Starting interest hints:</span>
             These broad interests help Meta find your first wave of shoppers. Once people start clicking and buying, Meta automatically discovers more customers just like them.
           </div>`
        : `<span class="muted">Add initial interest hints based on your niche</span>`
    )}`,
    ICONS.target,
    "neutral",
    4,
    "page-break-before"
  );

  // ── Budget (Card 5) ──
  const cleanBudgetReasoning = (() => {
    let text = budget.reasoning || "";
    if (!text) return "";
    text = fixPunctuationSpacing(text);

    if (numProductPrice > 0) {
      text = text.replace(
        /Calibrated for your product's [^ ]+ price point:/i,
        `Calibrated for your product's ${fmt(numProductPrice, currency, symbol)} price point:`
      );
    }

    // Sync international cities mentioned with the actual international cities displayed on Card 4
    if (intlLocs && intlLocs.length > 0) {
      const displayedIntlCityNames = intlLocs
        .map((l: { name?: string; city?: string }) => (l?.name || l?.city || "").split(",")[0].trim())
        .filter(Boolean)
        .slice(0, 4)
        .join(" · ");
      if (displayedIntlCityNames) {
        text = text.replace(
          /Should you ever wish to (?:explore international demand|test overseas sales) in [^,]+,/i,
          `Should you ever wish to test overseas sales in ${displayedIntlCityNames},`
        );
      }
    }

    const effectiveOverseas =
      intlBudgetStr ||
      (intlDaily ? `${formatCurrency(intlDaily, currency, symbol)}/day` : "");
    if (effectiveOverseas) {
      text = text.replace(
        /launch a separate overseas ad set at [^.]+?\./gi,
        `launch a separate overseas ad set at ${effectiveOverseas}.`
      );
    }
    // Clean up any double periods, stray closing parens before periods, or mismatched parens
    text = text.replace(/\)\./g, ".").replace(/\s*\.\s*/g, ". ").trim();
    return text;
  })();

  const parsedBudget = cleanBudgetReasoning ? parseBudgetReasoning(cleanBudgetReasoning) : null;

  const formattedBudgetReasoningHTML = (() => {
    if (!cleanBudgetReasoning && !budget.calculation) return "";
    const parsed = parsedBudget || {};
    let html = "";

    const dipDailyVal = Math.round((daily || 0) * 0.7);
    const dipDailyStr = parsed.dipDailyFormatted || (daily ? `${fmt(dipDailyVal, currency, symbol)}/day` : "");
    const dipTotalStr = daily ? fmt(dipDailyVal * duration, currency, symbol) : "";
    const sweetSpotDailyStr = daily ? `${fmt(daily, currency, symbol)}/day` : "";
    const sweetSpotTotalStr = daily ? fmt(daily * duration, currency, symbol) : "";

    const c = budget.calculation;
    const recentRevNum =
      c?.revenue_30d ??
      budget.breakdown?.revenue_based ??
      (parsed.recentRevenueFormatted
        ? parseFloat(parsed.recentRevenueFormatted.replace(/[^0-9.]/g, "")) || 0
        : 0);
    const totalTestSpendNum = daily ? daily * duration : 0;
    const pctOfRecent =
      recentRevNum > 0 ? Math.round((totalTestSpendNum / recentRevNum) * 100) : 0;
    const isTightCashFlow =
      Boolean(parsed.isCashFlowConstrained) || (recentRevNum > 0 && pctOfRecent > 25);

    html += `
      <div style="margin-top:7px; margin-bottom:7px; border:1px solid rgba(255,255,255,0.12); border-radius:8px; overflow:hidden; background:rgba(15,23,42,0.6);">
        <div style="padding:6px 10px; background:rgba(255,255,255,0.06); font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:#cbd5e1; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center;">
          <span>Transparent Budget Calculation Breakdown</span>
          <span style="font-size:9px; color:#94a3b8; font-weight:500;">Pre-Spend Intelligence</span>
        </div>
        <table style="width:100%; border-collapse:collapse; font-size:10px; text-align:left;">
          <tbody>
            <tr style="border-bottom:1px solid rgba(255,255,255,0.06);">
              <td style="padding:5px 10px; font-weight:600; color:#94a3b8; width:34%;">Store Sales Context</td>
              <td style="padding:5px 10px; color:#f1f5f9;">${
                recentRevNum > 0
                  ? `${esc(parsed.recentRevenueFormatted || fmt(recentRevNum, currency, symbol))} verified over latest 30 days`
                  : parsed.recentRevenueFormatted
                  ? `${esc(parsed.recentRevenueFormatted)} verified in Shopify store`
                  : "New store / early catalog testing baseline"
              }</td>
            </tr>
            <tr style="border-bottom:1px solid rgba(255,255,255,0.06);">
              <td style="padding:5px 10px; font-weight:600; color:#94a3b8;">How Budget Was Chosen</td>
              <td style="padding:5px 10px; color:#f1f5f9; line-height:1.4;">${
                c
                  ? c.selected_rule === "price_guardrail"
                    ? `<strong>Product-Calibrated Testing Budget:</strong> Sized for ${esc(params.productName)}'s ${esc(fmt(c.effective_price, currency, symbol))} price point, giving Meta sufficient daily budget headroom to identify genuine buyers while protecting test spend.`
                    : recentRevNum > 0
                    ? `<strong>Revenue-Calibrated Budget:</strong> Scaled to your store's recent ${esc(fmt(recentRevNum, currency, symbol))} monthly volume, providing enough ad delivery to test reliably while protecting cash flow.`
                    : `<strong>Starter Testing Baseline:</strong> Calibrated for your product's ${numProductPrice > 0 ? esc(fmt(numProductPrice, currency, symbol)) : "catalog"} price point to give Meta enough daily headroom to discover your first customers.`
                  : isTightCashFlow
                  ? `<strong>Starter Testing Baseline:</strong> Sized for your product's ${numProductPrice > 0 ? esc(fmt(numProductPrice, currency, symbol)) : "catalog"} price point to give Meta room to find buyers while keeping spend disciplined relative to recent sales.`
                  : recentRevNum > 0
                  ? `<strong>Revenue-Tier Testing Rule:</strong> Uses your store's recent ${esc(parsed.recentRevenueFormatted || fmt(recentRevNum, currency, symbol))} monthly volume to test reliably while protecting cash flow.`
                  : `<strong>Starter Testing Baseline:</strong> Calibrated for your product's ${numProductPrice > 0 ? esc(fmt(numProductPrice, currency, symbol)) : "catalog"} price point to give Meta enough daily headroom to discover your first customers.`
              }</td>
            </tr>
            <tr style="border-bottom:1px solid rgba(255,255,255,0.06); background:rgba(99,102,241,0.08);">
              <td style="padding:6px 10px; font-weight:700; color:#a5b4fc;">Recommended Test (${esc(budget.tier && budget.tier !== "Balanced" ? budget.tier : "Sweet Spot")})</td>
              <td style="padding:6px 10px; color:#fff; font-weight:600;"><span style="font-size:11.5px; color:#818cf8; font-weight:800;">${sweetSpotTotalStr} Total Spend</span> (${sweetSpotDailyStr} × ${duration} days) · Balanced testing baseline</td>
            </tr>
            <tr style="border-bottom:1px solid rgba(255,255,255,0.06); background:rgba(245,158,11,0.08);">
              <td style="padding:6px 10px; font-weight:700; color:#fcd34d;">Lower-Spend Option (Dip Your Toe)</td>
              <td style="padding:6px 10px; color:#fff; font-weight:600;">
                <span style="font-size:11.5px; color:#fbbf24; font-weight:800;">${dipTotalStr || "—"} Total Spend</span> (${esc(dipDailyStr)} × ${duration} days)
                ${
                  isTightCashFlow
                    ? `<div style="font-size:9px; color:#fef3c7; font-weight:400; margin-top:2px; line-height:1.35;">⚠️ Cash Flow Advisory: ${sweetSpotTotalStr} is about ${pctOfRecent}% of your recent 30-day sales. If cash is tight right now during this quiet spell, test with this lower option (${esc(dipDailyStr)}) to reduce your upfront risk while you collect early data, though gathering enough signals may take a few more days.</div>`
                    : `<div style="font-size:9px; color:#fef3c7; font-weight:400; margin-top:2px; line-height:1.35;">A lower-commitment test option (${esc(dipDailyStr)}). Reduces your upfront financial risk while you validate customer interest.</div>`
                }
              </td>
            </tr>
            ${
              showOverseas && intlDaily
                ? `<tr style="background:rgba(147,51,234,0.08);">
              <td style="padding:6px 10px; font-weight:700; color:#c084fc;">Optional Overseas Expansion</td>
              <td style="padding:6px 10px; color:#fff; font-weight:600;">
                <span style="font-size:11.5px; color:#c084fc; font-weight:800;">${fmt(intlDaily * intlDuration, currency, symbol)} Total Spend</span> (${fmt(intlDaily, currency, symbol)}/day × ${intlDuration} days) · Test only after your domestic campaign is proven profitable
              </td>
            </tr>`
                : ""
            }
          </tbody>
        </table>
        ${
          c?.fx && currency !== "USD"
            ? `<div style="padding:4px 10px; font-size:8.5px; color:#94a3b8; border-top:1px solid rgba(255,255,255,0.06); background:rgba(0,0,0,0.15);">
                💱 Budget baseline converted from Meta's global USD test volume at $1 USD ≈ ${c.fx.rate >= 10 ? Math.round(c.fx.rate).toLocaleString() : c.fx.rate.toFixed(2)} ${esc(c.fx.currency)}. This gives your campaign the same competitive ad delivery volume as international stores.
              </div>`
            : ""
        }
      </div>`;

    if (parsed.calibrationTitle || parsed.calibrationBody) {
      html += `<p style="margin-top:4px; font-size:10px; color:#e2e8f0; line-height:1.4;">${
        parsed.calibrationTitle ? `<strong style="color:#fff;">${esc(parsed.calibrationTitle)}</strong> ` : ""
      }${esc(parsed.calibrationBody || "")}</p>`;
    }
    if (parsed.recommendedPlan) {
      html += `<p style="margin-top:3px; font-size:10px; color:#e2e8f0; line-height:1.4;"><strong style="color:#fff;">Recommended Allocation:</strong> ${esc(parsed.recommendedPlan)}</p>`;
    }
    if (parsed.overseasExpansion) {
      html += `<div style="margin-top:5px; padding:5px 8px; background:rgba(99,102,241,0.12); border:1px solid rgba(129,140,248,0.25); border-radius:6px; font-size:9.5px; color:#e0e7ff; line-height:1.35;"><strong style="color:#a5b4fc;">🌍 Optional Overseas Expansion:</strong> ${esc(parsed.overseasExpansion)}</div>`;
    }
    if (parsed.rawFallback) {
      html += `<p style="margin-top:5px; font-size:10px; color:#e2e8f0; line-height:1.4;">${esc(parsed.rawFallback)}</p>`;
    }
    return html;
  })();

  let pricingStrategyHTML = "";
  if (numProductPrice > 0 && daily !== null && daily > 0) {
    const dailyAmount = daily;
    const totalTestSpend = dailyAmount * duration;
    const priceToDailyRatio = numProductPrice / dailyAmount;
    const formattedPrice = fmt(numProductPrice, currency, symbol);
    const formattedDaily = fmt(dailyAmount, currency, symbol);

    if (priceToDailyRatio >= 2.0 || (totalTestSpend > 0 && numProductPrice >= totalTestSpend * 0.7)) {
      pricingStrategyHTML = `
        <div style="padding:7px 10px; background:rgba(99,102,241,0.16); border:1px solid rgba(129,140,248,0.3); border-left:3px solid #818cf8; border-radius:6px;">
          <div style="font-size:10px; font-weight:700; color:#c7d2fe; display:flex; align-items:center; gap:5px; margin-bottom:2px;">
            <span>💎</span> Premium Piece Consideration Strategy (${formattedPrice} unit price vs ${formattedDaily}/day budget)
          </div>
          <p style="font-size:9.5px; color:#e2e8f0; margin-top:3px; line-height:1.4;">
            Because <strong style="color:#fff;">${esc(params.productName)}</strong> (${formattedPrice}) is a premium piece, shoppers often take time to consider sizing and details before purchasing. During your initial test, watch Add-to-Carts and Checkout Starts as strong leading indicators of intent. Even 1–2 orders at this price point delivers an exceptional return on ad spend.
          </p>
        </div>`;
    } else if (priceToDailyRatio < 1.2) {
      pricingStrategyHTML = `
        <div style="padding:7px 10px; background:rgba(16,185,129,0.16); border:1px solid rgba(52,211,153,0.3); border-left:3px solid #34d399; border-radius:6px;">
          <div style="font-size:10px; font-weight:700; color:#a7f3d0; display:flex; align-items:center; gap:5px; margin-bottom:2px;">
            <span>⚡</span> Fast-Conversion Impulse Strategy (${formattedPrice} unit price)
          </div>
          <p style="font-size:9.5px; color:#e2e8f0; margin-top:3px; line-height:1.4;">
            With a unit price well within your daily spend of ${formattedDaily}/day, <strong style="color:#fff;">${esc(params.productName)}</strong> sits at an accessible purchase threshold. New shoppers can make quick buying decisions on their very first visit.
          </p>
        </div>`;
    }
  }

  const budgetNotesGridHTML =
    (parsedBudget?.cashFlowTip || pricingStrategyHTML)
      ? `<div class="budget-notes-grid">
          ${
            parsedBudget?.cashFlowTip
              ? `<div style="padding:7px 10px; background:rgba(245,158,11,0.12); border:1px solid rgba(251,191,36,0.25); border-radius:6px; font-size:9.5px; color:#fef3c7; line-height:1.4;"><strong style="color:#fde68a;">💡 Cash Flow Protection:</strong> ${esc(parsedBudget.cashFlowTip)}</div>`
              : ""
          }
          ${pricingStrategyHTML}
        </div>`
      : "";

  const budgetHTML = (() => {
    const fallbackRate = getEstimatedExchangeRate(currency);
    const overseasTargetUSD =
      intlTier === "Dip Your Toe" ? 18 : intlTier === "Full Send" ? 40 : 25;
    const effectiveRate =
      showOverseas && intlDaily && intlDaily > 0 && overseasTargetUSD > 0
        ? intlDaily / overseasTargetUSD
        : fallbackRate;

    const localDailyUSD =
      daily && effectiveRate > 0 ? Math.max(1, Math.round(daily / effectiveRate)) : null;
    const localDailyStr = daily ? fmt(daily, currency, symbol) : "";
    const intlDailyUSD =
      intlDaily && effectiveRate > 0 ? Math.max(1, Math.round(intlDaily / effectiveRate)) : overseasTargetUSD;
    const intlDailyStr = intlDaily ? fmt(intlDaily, currency, symbol) : "";

    const multiMarketCurrencyTipHTML =
      currency !== "USD" && localDailyUSD
        ? `<p style="margin-top:7px; color:#cbd5e1;"><strong>💱 Ad Account Currency Tip:</strong> If your Meta Ads Manager account bills you in US Dollars ($) instead of ${esc(
            currency
          )}, enter <strong>~$${localDailyUSD}/day USD</strong> for your primary local campaign (equivalent to ${localDailyStr}/day)${
            showOverseas && intlDaily
              ? `, or <strong>~$${intlDailyUSD}/day USD</strong> if you launch the separate overseas test campaign (${intlDailyStr}/day)`
              : ""
          }. <em>(Estimated currency conversion; actual billing depends on your payment card's daily exchange rate.)</em></p>`
        : currency !== "USD"
        ? `<p style="margin-top:7px; color:#cbd5e1;"><strong>💱 Ad Account Currency Tip:</strong> If your Meta Ads Manager account bills you in US Dollars ($) instead of ${esc(
            currency
          )}, enter the equivalent daily USD directly in Ads Manager so exchange rate shifts don't cause Meta to slow down ad delivery. <em>(Estimated currency conversion; verify with your current exchange rate.)</em></p>`
        : "";

    const singleMarketCurrencyTipHTML =
      currency !== "USD" && localDailyUSD
        ? `<p style="margin-top:7px; color:#cbd5e1;"><strong>💱 Ad Account Currency Tip:</strong> If your Meta Ads Manager account bills you in US Dollars ($) instead of ${esc(
            currency
          )}, enter <strong>~$${localDailyUSD}/day USD</strong> (equivalent to ${localDailyStr}/day) directly in Ads Manager so exchange rate shifts don't cause Meta to slow down ad delivery. <em>(Estimated currency conversion; actual billing depends on your payment card's daily exchange rate.)</em></p>`
        : currency !== "USD"
        ? `<p style="margin-top:7px; color:#cbd5e1;"><strong>💱 Ad Account Currency Tip:</strong> If your Meta Ads Manager account bills you in US Dollars ($) instead of ${esc(
            currency
          )}, enter the equivalent daily USD directly in Ads Manager so exchange rate shifts don't cause Meta to slow down ad delivery. <em>(Estimated currency conversion; verify with your current exchange rate.)</em></p>`
        : "";

    return card(
      "Budget & spending plan",
      `
      ${
        showOverseas
          ? `<div class="budget-grid">
        <!-- Local Primary Market -->
        <div class="budget-card local">
          <div class="budget-card-header">
            <span class="budget-card-title">📍 Primary Market (Local)</span>
            <span class="budget-badge local">Start Here</span>
          </div>
          <div class="budget-card-amount">
            ${daily ? fmt(daily, currency, symbol) : "Set manually"}<span class="budget-unit">/day</span>
          </div>
          <div class="budget-card-sub">
            ${esc(budget.tier || "Sweet Spot")} Strategy · 1 Local Ad Set
          </div>
          <div class="budget-meta" style="min-width:0; border-top:1px solid var(--subtle-2); padding-top:8px;">
            ${row("Test Duration", `${duration} days`)}
            ${daily ? row("Total Test Spend", fmt(daily * duration, currency, symbol)) : ""}
            ${row("Delivery", "Core domestic sales")}
          </div>
        </div>

        <!-- Overseas Test (Optional) -->
        <div class="budget-card intl">
          <div class="budget-card-header">
            <span class="budget-card-title">🌍 Overseas Test (Optional)</span>
            <span class="budget-badge intl">Suggested Expansion</span>
          </div>
          <div class="budget-card-amount">
            ${
              intlDaily
                ? fmt(intlDaily, currency, symbol)
                : esc(intlBudgetStr || "Set manually")
            }<span class="budget-unit">/day</span>
          </div>
          <div class="budget-card-sub">
            ${esc(intlTier)} Strategy · 1 Separate Ad Set
          </div>
          <div class="budget-meta" style="min-width:0; border-top:1px solid #e0e7ff; padding-top:8px;">
            ${row("Optional Duration", `${intlDuration} days`)}
            ${intlDaily ? row("Estimated Test Spend", fmt(intlDaily * intlDuration, currency, symbol)) : ""}
            ${row("Delivery", "Group into 1 ad set")}
          </div>
        </div>
      </div>

      ${
        showOverseas && intlDaily
          ? `<div style="margin-top:10px; margin-bottom:12px; padding:10px 14px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; display:flex; justify-content:space-between; align-items:center; font-size:11px; flex-wrap:wrap; gap:6px;">
        <div style="color:#475569;">
          <strong style="color:#0f172a;">Combined Ad Commitment:</strong> If launching both independent ad sets simultaneously:
        </div>
        <div style="font-weight:800; color:#0f172a;">
          Local: ${daily ? fmt(daily * duration, currency, symbol) : "—"} (${duration}d) + Overseas: ${fmt(intlDaily * intlDuration, currency, symbol)} (${intlDuration}d) = Total ${fmt((daily ? daily * duration : 0) + intlDaily * intlDuration, currency, symbol)}
        </div>
      </div>`
          : ""
      }

      ${engineLogic(
        "How your budget was calculated",
        `<p style="font-size:10px; line-height:1.45;"><strong>Two Independent Budgets:</strong> Run your <strong>Primary Local Campaign</strong> first to establish solid domestic cash flow. The <strong>Overseas Campaign</strong> is an optional expansion to test only when you want to explore buyers abroad — never combine local and overseas audiences into the same ad set.</p>
         ${multiMarketCurrencyTipHTML}
         ${formattedBudgetReasoningHTML}
         ${budgetNotesGridHTML}`
      )}`
          : `<div class="budget-grid" style="grid-template-columns: 1fr;">
        <!-- Single Consolidated Campaign -->
        <div class="budget-card local">
          <div class="budget-card-header">
            <span class="budget-card-title">📍 Recommended Campaign Budget</span>
            <span class="budget-badge local">Advantage+</span>
          </div>
          <div class="budget-card-amount">
            ${daily ? fmt(daily, currency, symbol) : "Set manually"}<span class="budget-unit">/day</span>
          </div>
          <div class="budget-card-sub">
            ${esc(budget.tier || "Sweet Spot")} Strategy · 1 Consolidated Ad Set
          </div>
          <div class="budget-meta" style="min-width:0; border-top:1px solid var(--subtle-2); padding-top:6px;">
            ${row("Test Duration", `${duration} days`)}
            ${daily ? row("Total Test Spend", fmt(daily * duration, currency, symbol)) : ""}
            ${row("Delivery", isUS ? "United States (Nationwide)" : "Core domestic sales")}
          </div>
        </div>
      </div>

      ${engineLogic(
        "How your budget was calculated",
        `<p style="font-size:10px; line-height:1.45;"><strong>Single Consolidated Campaign:</strong> Run as 1 Advantage+ ad set so Meta can focus your entire budget on finding your best customers without splitting your spend across multiple ad sets.</p>
         ${singleMarketCurrencyTipHTML}
         ${formattedBudgetReasoningHTML}
         ${budgetNotesGridHTML}`
      )}`
      }`,
      ICONS.budget,
      "neutral",
      5,
      "page-break-before"
    );
  })();

  // ── Timing & Sales Expectations (Card 6) ──
  const cleanTimingReasoning = fixPunctuationSpacing(
    timing.reasoning ||
      "Keep your ads running 24/7 without turning them on and off. Meta gets smarter over the week as it learns who clicks and buys. Slower weekdays are normal warm-ups that introduce your brand to shoppers so they are ready to purchase during your peak buying days."
  );
  const rawTimingLaunch = fixPunctuationSpacing(timing.launch_recommendation || "");
  let cleanTimingLaunch = rawTimingLaunch;
  if (cleanTimingLaunch) {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    for (const d of days) {
      if (d.toLowerCase() !== launchDayName.toLowerCase()) {
        cleanTimingLaunch = cleanTimingLaunch.replace(
          new RegExp(`\\b(?:on\\s+a\\s+)?${d}(?:\\s+night)?\\s+at\\s+midnight\\b`, "gi"),
          `${launchDayName} at 12:00 AM (midnight)`
        );
        cleanTimingLaunch = cleanTimingLaunch.replace(
          new RegExp(`\\bmidnight(?:\\s+[a-zA-Z\\s]+time)?\\s+on\\s+(?:a\\s+)?${d}\\b`, "gi"),
          `12:00 AM (midnight ${storeTimezoneName}) as ${launchDayName} begins`
        );
      }
    }
  }

  let timingHTML = "";
  if (peakDays.length > 0 || timing.launch_recommendation) {
    timingHTML = card(
      "When to run your ads",
      `
      ${
        cleanTimingLaunch
          ? field(
              "Launch schedule",
              `<p class="prose"><strong>Recommended launch time:</strong> ${esc(preciseLaunchTiming)}.<br/>${esc(cleanTimingLaunch)}</p>`
            )
          : field(
              "Launch schedule",
              `<p class="prose"><strong>Recommended launch time:</strong> ${esc(preciseLaunchTiming)}.<br/>Schedule your campaign to start on ${esc(launchDayName)} at 12:00 AM (midnight ${esc(storeTimezoneName)}) so Meta has a full 24-hour cycle to pace your daily budget smoothly across your first active sales day.</p>`
            )
      }
      ${
        peakDays.length > 0
          ? field(
              "Peak buying days (from your Shopify orders)",
              `${tagList(peakDays, "info")}<div style="font-size:10.5px; color:#475569; margin-top:4px; font-weight:500;">✓ Based on order history: Shoppers placed the most orders on ${esc(peakDays.join(", "))}. Past order timing reflects historical customer activity, not an algorithmic guarantee of future ad performance.</div>`
            )
          : ""
      }
      ${engineLogic(
        "Why keep ads running 24/7 (even on slower days)",
        `<p>${esc(cleanTimingReasoning)}</p>`
      )}`,
      ICONS.timing,
      "neutral",
      6,
      "page-break-before"
    );
  }

  // ── New launch note ──
  const newLaunchNoteHTML = params.isNewLaunch
    ? `<div class="callout callout-success callout-standalone"><span class="callout-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS.rocket}</svg></span><div><div class="callout-label">New launch</div><p>Audience suggestions are built from your store's customer data — Meta will automatically find more buyers as orders come in.</p></div></div>`
    : "";

  // ── Implementation guide (Card 7) ──
  const steps = params.implementation_steps ?? [
    {
      level: "Campaign level" as const,
      title: "Choose Sales Objective",
      instructions: campaignType.includes("ASC")
        ? "In Meta Ads Manager, click the green '+ Create' button. Select 'Sales' as your campaign objective and choose 'Advantage+ Shopping Campaign'."
        : "In Meta Ads Manager, click the green '+ Create' button. Select 'Sales' as your campaign objective, click Continue, and choose 'Manual Sales Campaign' with Advantage+ Audience enabled.",
    },
    {
      level: "Ad set level" as const,
      title: "Budget, Audience & Conversion",
      instructions: `First confirm the ${optimizationEvent === "AddToCart" ? "Add to Cart" : optimizationEvent === "InitiateCheckout" ? "Initiate Checkout" : optimizationEvent} event is active in Meta Events Manager. Then under Conversion, choose 'Website' and select that event. Set your daily budget to ${domesticBudgetStr || "your recommended daily budget"}. Set start schedule to ${preciseLaunchTiming}. Under Audience, add your suggested locations and set age to ${ageMin}–${ageMax} (${genderLabel === "All" ? "Men & Women" : genderLabel}).`,
    },
    {
      level: "Ad level" as const,
      title: "Creative & Copy",
      instructions: `Upload your product photos or vertical video. Copy and paste your Primary Text, Headline, and Description from Page 2. Set your Call to Action button to '${copy.cta || "Shop Now"}'. Publish after the website event check is complete.`,
    },
  ];

  const implementationGuideHTML = card(
    "Step-by-step Meta Ads Manager guide",
    `<div class="steps">${steps
      .map(
        (s, i) =>
          `<div class="step"><span class="step-num">${
            i + 1
          }</span><div><div class="step-title">${esc(
            s.level
          )} · ${esc(s.title || "")}</div><div class="step-desc">${esc(
            s.instructions
          )}</div></div></div>`
      )
      .join("")}</div>
    <p class="guide-foot">Follow these 3 quick steps in Meta Ads Manager to launch your campaign with confidence.</p>`,
    ICONS.guide,
    "neutral",
    7
  );

  // ── Day 7 Decision Tree & Scaling Playbook (Card 8) ──
  const totalTestSpend = daily ? Math.round(daily * duration) : 0;
  const midpointSpend = totalTestSpend ? Math.round(totalTestSpend * 0.5) : 0;
  const scaleBudgetVal = daily ? Math.round(daily * 1.2) : 0;
  const contributionCeiling = decisionEvidence?.price_less_unit_cost ?? null;
  const targetCpa = numProductPrice > 0 ? Math.round(numProductPrice * 0.35) : null;
  const contributionLabel = contributionCeiling !== null
    ? `Target ad spend per sale: under ${fmt(contributionCeiling, currency, symbol)} (keeps each order profitable)`
    : targetCpa
    ? `Target ad spend per sale: under ~${fmt(targetCpa, currency, symbol)} (~35% of piece price)`
    : "Keep ad spend per sale comfortably under your product profit margin";

  const decisionTreeHTML = card(
    `What to do after Day ${duration} (How to read your results)`,
    `<p class="section-intro" style="margin-bottom:8px;">Once your ${duration}-day test finishes, compare its results with your store evidence and verified unit economics. Match what happened to one of these 3 situations:</p>
    
    <div style="font-size:10px; color:#1e293b; background:#f1f5f9; border:1px solid #cbd5e1; border-left:4px solid #4f46e5; padding:6px 10px; border-radius:6px; margin-bottom:8px; line-height:1.45;">
      <strong>⏱️ Founder Rule: Give Meta 48–72 hours before making changes.</strong> Ad performance naturally fluctuates day to day. Use spend checkpoints (25% check delivery, 50% compare hooks, 100% scale or pause) to judge true shopper trends rather than hourly noise.
    </div>

    <div class="decision-grid">
      <!-- Green Light -->
      <div class="decision-card decision-green">
        <div class="decision-card-head">
          <span class="decision-tag green">🟢 It's Working · Profitable Orders</span>
          <div class="decision-metric">${esc(contributionLabel)}</div>
        </div>
        <p class="decision-meaning">Shoppers are buying and orders are rolling in! Your creative angle and audience are resonating with paying customers.</p>
        <div class="decision-action">
          <div style="font-size:9.5px; background:#f0fdf4; border:1px solid #bbf7d0; padding:5px 9px; border-radius:5px; margin-bottom:5px; color:#166534; font-weight:600;">
            Founder Profit Check: Money Made − Ad Spend − Product Cost − Delivery − Payment Fees = Real Cash in Pocket
          </div>
          <div style="display:flex; flex-direction:column; gap:3px;">
            <div><strong>• Verify net profit:</strong> Ensure customer revenue comfortably covers production, shipping, and payment gateway fees.</div>
            <div><strong>• When to scale:</strong> Once you see consistent orders, increase your daily budget gradually (by ~20% every 3–4 days${daily ? `, e.g. from ${fmt(daily, currency, symbol)} to ${fmt(scaleBudgetVal, currency, symbol)}/day` : ""}) to grow volume while preserving ad delivery efficiency.</div>
          </div>
        </div>
      </div>

      <div class="decision-subgrid">
        <!-- Yellow Light -->
        <div class="decision-card decision-yellow">
          <div class="decision-card-head">
            <span class="decision-tag yellow">🟡 High Carts, Low Orders</span>
            <div class="decision-metric">${esc(recentFunnelSummary)}</div>
          </div>
          <p class="decision-meaning">Shoppers love what they see and added the piece to their cart, but paused before completing payment. Your ad has done its job—the drop-off almost always happens on the checkout page.</p>
          <div class="decision-action">
            <strong>Key friction checks to turn carts into sales:</strong>
            <ul style="margin:4px 0 0 16px; padding:0; list-style-type:disc; line-height:1.45;">
              <li style="margin-bottom:2px;"><strong>Surprise delivery fees:</strong> Are shipping costs revealed too late? Show flat or free delivery upfront.</li>
              <li style="margin-bottom:2px;"><strong>Payment options:</strong> Are local cards and instant bank transfers working smoothly?</li>
              <li><strong>Shopper reassurance:</strong> Add a simple WhatsApp sizing link or clear returns note on the product page.</li>
            </ul>
          </div>
        </div>

        <!-- Red Light -->
        <div class="decision-card decision-red">
          <div class="decision-card-head">
            <span class="decision-tag red">🔴 Low Clicks / Refresh Hook</span>
            <div class="decision-metric">At 50% of test budget${midpointSpend ? ` (${fmt(midpointSpend, currency, symbol)} spent)` : ""}: link CTR &lt; 0.8% and few page visits</div>
          </div>
          <p class="decision-meaning">People are scrolling past without clicking. The opening 3-second visual or headline hook isn't stopping thumbs in the feed.</p>
          <div class="decision-action">
            <strong>What to do next:</strong>
            <p style="margin-top:2px;">Don't start over or delete your campaign. Keep your audience settings, pause this ad visual, and test <strong>Angle 2 (${esc(actualAngleLabels[1] || "Craft & Quality")})</strong> or <strong>Angle 3 (${esc(actualAngleLabels[2] || "Everyday Fit")})</strong> from Page 3 to find the visual that catches attention.</p>
          </div>
        </div>
      </div>
    </div>`,
    ICONS.tree,
    "neutral",
    8,
    "page-break-before"
  );

  const chrome = opts?.embed
    ? ""
    : `
<div class="toolbar no-print">
  <span class="toolbar-text">Your campaign brief is ready</span>
  <button class="btn" onclick="window.print()">Save as PDF</button>
</div>

<script>
  window.onload = function () {
    setTimeout(function () { window.print(); }, 800);
  };
</script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(params.productName ? `${params.productName} — Omni Target Campaign Brief` : "Omni Target Campaign Brief")}</title>
<style>
  ${fontFaceCSS}
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  :root{
    --ink:#4f46e5; --ink-2:#6366f1;
    --text-1:#18181b; --text-2:#52525b; --text-3:#8a8a94;
    --bg:#eef0f3; --sheet:#ffffff; --subtle:#f6f7f9; --subtle-2:#f1f2f4;
    --border:#e6e7ea; --border-2:#dcdde1;
    --font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  }
  @page { size: auto; margin: 0; }
  html{ -webkit-print-color-adjust:exact!important; print-color-adjust:exact!important; background:var(--bg); }
  body{ font-family:var(--font); background:var(--bg); color:var(--text-1); font-size:11.5px; line-height:1.6; padding:16px 0 0; }

  .sheet{ width:760px; max-width:94%; margin:0 auto; background:var(--sheet); border:1px solid var(--border); border-radius:18px; overflow:hidden; box-shadow:0 24px 60px -24px rgba(9,9,15,.18); }

  /* Header */
  .header{ position:relative; padding:40px 48px 34px; background:linear-gradient(180deg,#fafafb 0%,#ffffff 100%); border-bottom:1px solid var(--border); }
  .header::before{ content:''; position:absolute; top:0; left:0; right:0; height:4px; background:linear-gradient(90deg,var(--ink) 0%,var(--ink-2) 60%,transparent 100%); }
  .header-top{ display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:26px; }
  .wordmark{ display:flex; align-items:center; gap:9px; font-size:15px; font-weight:800; letter-spacing:-.3px; color:var(--ink); }
  .logo-badge{ width:26px; height:26px; border-radius:7px; background:var(--ink); display:block; }
  .badge{ font-size:8px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:var(--ink); border:1px solid var(--border-2); background:var(--subtle); padding:6px 12px; border-radius:100px; }
  .eyebrow{ font-size:9px; font-weight:700; letter-spacing:2.4px; text-transform:uppercase; color:var(--text-3); margin-bottom:10px; }
  .h1{ font-size:32px; font-weight:800; letter-spacing:-1.2px; line-height:1.08; color:var(--ink); margin-bottom:8px; }
  .brand{ font-size:12.5px; color:var(--text-2); font-weight:500; }
  .prod-link{ font-size:11px; color:var(--text-3); text-decoration:none; }
  .meta-row{ display:flex; flex-wrap:wrap; gap:8px; margin-top:18px; }
  .chip{ display:inline-flex; align-items:center; gap:7px; font-size:10px; font-weight:600; color:#fff; background:var(--ink); border-radius:8px; padding:7px 13px; }
  .chip-dot{ width:5px; height:5px; border-radius:50%; background:#fff; opacity:.7; }
  .chip-soft{ display:inline-flex; align-items:center; gap:6px; font-size:9px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#15803d; background:#f0fdf4; border:1px solid #c6f0d2; border-radius:100px; padding:6px 12px; }
  .header-date{ font-size:9px; color:var(--text-3); font-weight:600; margin-top:6px; text-align:right; }

  /* Content */
  .content{ padding:24px 44px 32px; }

  /* Executive Flight Deck (Page 1 Control Panel) */
  .flight-deck{ background:linear-gradient(180deg,#fafbff 0%,#f4f6fa 100%); border:1.5px solid #cbd5e1; border-radius:14px; padding:18px 20px; margin-bottom:18px; page-break-inside:avoid; box-shadow:0 4px 14px -4px rgba(15,23,42,.06); }
  .flight-deck-head{ display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid #e2e8f0; }
  .flight-deck-title{ display:flex; align-items:center; gap:8px; font-size:9.5px; font-weight:800; letter-spacing:1.6px; text-transform:uppercase; color:var(--ink); }
  .flight-deck-icon{ color:var(--ink); display:flex; align-items:center; }
  .flight-deck-icon svg{ width:15px; height:15px; }
  .flight-deck-badge{ font-size:8px; font-weight:700; letter-spacing:1px; text-transform:uppercase; background:#e0e7ff; color:#3730a3; padding:4px 10px; border-radius:100px; border:1px solid #c7d2fe; }

  .flight-metric-grid{ display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:12px; }
  @media(max-width:640px){ .flight-metric-grid{ grid-template-columns:repeat(2,1fr); } }
  .flight-metric{ background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:11px 12px; }
  .flight-metric-val{ font-size:15px; font-weight:800; letter-spacing:-.4px; color:var(--ink); line-height:1.15; }
  .flight-metric-unit{ font-size:11px; font-weight:600; color:var(--text-3); }
  .flight-sku{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
  .flight-metric-label{ font-size:8px; font-weight:800; letter-spacing:1px; text-transform:uppercase; color:var(--text-3); margin-top:5px; }
  .flight-metric-sub{ font-size:9px; font-weight:600; color:var(--text-2); margin-top:2px; }

  /* Cheat Sheet Grid */
  .cheat-sheet{ background:#fff; border:1px solid #e2e8f0; border-radius:10px; overflow:hidden; }
  .cheat-sheet-head{ background:#f1f5f9; padding:7px 12px; font-size:8px; font-weight:800; letter-spacing:1.4px; text-transform:uppercase; color:#475569; border-bottom:1px solid #e2e8f0; }
  .cheat-sheet-grid{ display:grid; grid-template-columns:1fr 1fr; }
  @media(max-width:600px){ .cheat-sheet-grid{ grid-template-columns:1fr; } }
  .cheat-cell{ padding:8px 12px; border-bottom:1px solid #f1f5f9; display:flex; flex-direction:column; gap:2px; }
  .cheat-cell:nth-child(odd){ border-right:1px solid #f1f5f9; }
  .cheat-label{ font-size:7.5px; font-weight:800; letter-spacing:1px; text-transform:uppercase; color:#64748b; }
  .cheat-val{ font-size:10.5px; font-weight:700; color:#0f172a; line-height:1.35; }

  /* Clipping Cards (Copy-Paste Ready) */
  .clip-card{ border:1.5px dashed #cbd5e1; background:#f8fafc; border-radius:10px; padding:12px 14px; margin-bottom:11px; }
  .clip-head{ display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
  .clip-tag{ font-size:8px; font-weight:800; letter-spacing:1px; text-transform:uppercase; color:#475569; background:#e2e8f0; padding:2px 7px; border-radius:4px; font-family:monospace; }
  .clip-body{ font-size:11.5px; line-height:1.65; color:#0f172a; }
  .clip-selectable{ user-select:all; -webkit-user-select:all; }
  .clip-row{ display:flex; gap:10px; }
  @media(max-width:600px){ .clip-row{ flex-direction:column; } }

  /* Engine Logic Accent Box */
  .engine-logic{ background:linear-gradient(135deg,#090d16 0%,#151b2e 100%); color:#e2e8f0; border:1px solid #283049; border-left:4px solid #6366f1; border-radius:10px; padding:10px 14px; margin:8px 0; page-break-inside:avoid; }
  .engine-logic-head{ display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:7px; border-bottom:1px solid rgba(255,255,255,.1); padding-bottom:5px; }
  .engine-logic-tag{ font-size:8.5px; font-weight:800; letter-spacing:1.4px; text-transform:uppercase; color:#818cf8; font-family:monospace; }
  .engine-logic-title{ font-size:9.5px; font-weight:700; color:#cbd5e1; text-transform:uppercase; letter-spacing:.6px; }
  .engine-logic-body{ font-size:10.5px; line-height:1.55; color:#cbd5e1; }
  .engine-logic-body p{ margin-bottom:5px; } .engine-logic-body p:last-child{ margin-bottom:0; }
  .engine-logic-body strong{ color:#fff; font-weight:700; }

  /* Card */
  .card{ background:#fff; border:1px solid var(--border); border-radius:14px; margin-bottom:12px; overflow:hidden; page-break-inside:avoid; }
  .card-head{ display:flex; align-items:center; gap:11px; padding:12px 18px; border-bottom:1px solid var(--subtle-2); }
  .card-icon{ width:30px; height:30px; border-radius:8px; border:1px solid; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .card-icon svg{ width:16px; height:16px; }
  .card-label{ font-size:11px; font-weight:800; letter-spacing:1.6px; text-transform:uppercase; color:var(--text-1); }
  .card-num{ margin-left:auto; font-size:11px; font-weight:800; color:var(--text-3); letter-spacing:1px; }
  .card-body{ padding:12px 18px; }

  /* Fields */
  .field{ margin-bottom:15px; } .field:last-child{ margin-bottom:0; }
  .field-label{ font-size:8.5px; font-weight:700; letter-spacing:1.6px; text-transform:uppercase; color:var(--text-3); margin-bottom:6px; }
  .field-value{ font-size:11.5px; color:var(--text-1); line-height:1.65; }
  .headline{ font-size:17px; font-weight:800; letter-spacing:-0.01em; word-spacing:normal; color:var(--ink); line-height:1.25; }
  .two-col{ display:flex; gap:24px; } .two-col .field{ flex:1; }
  .hr{ height:1px; background:var(--subtle-2); margin:4px 0 15px; }

  .prose{ font-size:11.5px; line-height:1.7; color:var(--text-1); }
  .muted{ color:var(--text-3); font-style:italic; }
  .muted-prose{ color:var(--text-2); }
  .reasoning{ font-size:10px; color:var(--text-3); line-height:1.6; margin:-8px 0 14px; }
  .stat-inline{ font-size:15px; font-weight:800; color:var(--ink); letter-spacing:-.3px; }

  /* Tags */
  .tag{ display:inline-block; font-size:9.5px; font-weight:600; border:1px solid; border-radius:7px; padding:4px 10px; margin:0 5px 5px 0; }
  .pill{ display:inline-block; font-size:9.5px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; border:1px solid; border-radius:100px; padding:4px 11px; margin-bottom:12px; }
  .cta-badge{ display:inline-block; font-size:11px; font-weight:700; background:var(--ink); color:#fff; border-radius:8px; padding:7px 15px; letter-spacing:.2px; }

  /* Creative Hooks styling */
  .section-intro{ font-size:11px; color:var(--text-2); margin-bottom:14px; }
  .hooks-grid{ display:flex; flex-direction:column; gap:12px; }
  .hook-box{ background:var(--subtle); border:1px solid var(--border); border-radius:10px; padding:12px 14px; }
  .hook-head{ display:flex; align-items:center; gap:8px; margin-bottom:8px; }
  .hook-number{ width:18px; height:18px; border-radius:50%; background:var(--ink); color:#fff; font-size:9.5px; font-weight:800; display:flex; align-items:center; justify-content:center; }
  .hook-angle{ font-size:11px; font-weight:700; color:var(--ink); }
  .hook-body{ display:flex; flex-direction:column; gap:5px; }
  .hook-row{ display:flex; gap:8px; font-size:11px; line-height:1.5; }
  .hook-label{ font-size:10px; font-weight:600; color:var(--text-3); width:85px; flex-shrink:0; }
  .hook-val{ color:var(--text-1); flex:1; }
  .hook-overlay{ font-family:monospace; background:rgba(79,70,229,.08); color:#4338ca; border:1px solid rgba(79,70,229,.18); padding:1px 6px; border-radius:4px; font-size:10.5px; font-weight:600; }
  .hook-opening{ font-style:italic; color:var(--text-1); font-weight:500; }

  /* Callout */
  .callout{ border:1px solid var(--border); background:var(--subtle); border-radius:10px; padding:12px 14px; margin-top:4px; }
  .callout p{ font-size:11px; color:var(--text-1); line-height:1.6; }
  .callout-label{ font-size:8.5px; font-weight:800; letter-spacing:1.4px; text-transform:uppercase; color:var(--text-2); margin-bottom:5px; }
  .callout-info{ background:#f7f8fa; border-color:var(--border); }
  .callout-success{ background:#f0fdf4; border-color:#c6f0d2; } .callout-success .callout-label{ color:#15803d; }
  .callout-standalone{ display:flex; gap:12px; align-items:flex-start; margin-bottom:16px; }
  .callout-ic{ flex-shrink:0; width:30px; height:30px; border-radius:8px; background:#fff; border:1px solid #c6f0d2; color:#15803d; display:flex; align-items:center; justify-content:center; }
  .callout-ic svg{ width:16px; height:16px; }

  /* Intel */
  .intel{ display:flex; gap:20px; align-items:flex-start; }
  .intel-main{ flex:1; min-width:0; }
  .intel-img img{ width:100px; height:100px; object-fit:cover; border-radius:12px; border:1px solid var(--border); display:block; }

  /* Quote */
  .quote{ position:relative; background:var(--ink); color:#fff; border-radius:14px; padding:22px 26px 22px 56px; margin-bottom:16px; overflow:hidden; page-break-inside:avoid; }
  .quote-mark{ position:absolute; left:18px; top:8px; font-size:54px; font-weight:800; line-height:1; color:rgba(255,255,255,.16); font-family:Georgia,serif; }
  .quote-label{ font-size:8.5px; font-weight:800; letter-spacing:2px; text-transform:uppercase; color:rgba(255,255,255,.5); margin-bottom:8px; }
  .quote-text{ font-size:13px; line-height:1.7; color:#fff; font-weight:500; }

  /* Budget */
  .budget-hero{ display:flex; justify-content:space-between; align-items:flex-start; gap:16px; padding-bottom:12px; margin-bottom:12px; border-bottom:1px solid var(--subtle-2); }
  .budget-grid{ display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:8px; }
  @media(max-width:600px){ .budget-grid{ grid-template-columns:1fr; } }
  .budget-card{ border-radius:9px; padding:7px 11px; page-break-inside:avoid; }
  .budget-card.local{ background:var(--subtle); border:1.5px solid var(--ink); }
  .budget-card.intl{ background:#fafafe; border:1.5px dashed #6366f1; }
  .budget-card-header{ display:flex; justify-content:space-between; align-items:center; margin-bottom:2px; }
  .budget-card-title{ font-size:8.5px; font-weight:800; text-transform:uppercase; letter-spacing:.5px; }
  .budget-card.local .budget-card-title{ color:var(--ink); }
  .budget-card.intl .budget-card-title{ color:#4338ca; }
  .budget-badge{ font-size:7.5px; font-weight:700; padding:2px 5px; border-radius:9999px; text-transform:uppercase; letter-spacing:.3px; }
  .budget-badge.local{ background:var(--ink); color:#fff; }
  .budget-badge.intl{ background:#ede9fe; color:#6d28d9; }
  .budget-card-amount{ font-size:18px; font-weight:800; letter-spacing:-.6px; line-height:1.1; color:var(--ink); margin-top:1px; }
  .budget-card.intl .budget-card-amount{ color:#1e1b4b; }
  .budget-card-sub{ font-size:8.5px; font-weight:600; margin-top:1px; margin-bottom:4px; }
  .budget-card.local .budget-card-sub{ color:var(--text-2); }
  .budget-card.intl .budget-card-sub{ color:#4f46e5; }
  .budget-amount{ font-size:24px; font-weight:800; letter-spacing:-1px; color:var(--ink); line-height:1; margin-top:2px; }
  .budget-unit{ font-size:11.5px; font-weight:600; color:var(--text-3); letter-spacing:0; }
  .budget-tier{ font-size:8px; font-weight:800; letter-spacing:1.2px; text-transform:uppercase; color:var(--text-2); margin-top:4px; }
  .budget-meta{ min-width:170px; }
  .row{ display:flex; justify-content:space-between; align-items:center; padding:2px 0; border-bottom:1px solid var(--subtle-2); }
  .row:last-child{ border-bottom:none; }
  .row-label{ font-size:8px; color:var(--text-3); font-weight:700; text-transform:uppercase; letter-spacing:.5px; }
  .row-value{ font-size:10px; color:var(--text-1); font-weight:700; }
  .breakdown{ background:var(--subtle); border:1px solid var(--border); border-radius:9px; padding:5px 12px; }
  .budget-notes-grid{ display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:6px; margin-top:6px; }

  /* Warnings */
  .warn-list{ display:flex; flex-direction:column; gap:10px; }
  .warn-item{ display:flex; align-items:flex-start; gap:11px; }
  .warn-icon{ flex-shrink:0; width:22px; height:22px; border-radius:7px; background:#fffaeb; border:1px solid #fbe6bf; color:#b45309; display:flex; align-items:center; justify-content:center; }
  .warn-icon svg{ width:13px; height:13px; }
  .warn-item span:last-child{ font-size:11px; color:var(--text-1); line-height:1.6; padding-top:2px; }

  /* Steps */
  .steps{ display:flex; flex-direction:column; gap:11px; }
  .step{ display:flex; gap:13px; align-items:flex-start; background:var(--subtle); border:1px solid var(--border); border-radius:10px; padding:13px 15px; }
  .step-num{ flex-shrink:0; width:24px; height:24px; border-radius:7px; background:var(--ink); color:#fff; font-size:12px; font-weight:800; display:flex; align-items:center; justify-content:center; }
  .step-title{ font-size:12px; font-weight:700; color:var(--ink); margin-bottom:3px; }
  .step-desc{ font-size:11px; color:var(--text-2); line-height:1.55; }
  .guide-foot{ margin-top:13px; font-size:10.5px; font-style:italic; color:var(--text-3); text-align:center; }

  /* Decision Tree Playbook */
  .decision-grid{ display:flex; flex-direction:column; gap:6px; margin-top:4px; }
  .decision-subgrid{ display:grid; grid-template-columns:1fr 1fr; gap:6px; }
  @media(max-width:640px){ .decision-subgrid{ grid-template-columns:1fr; } }
  .decision-card{ background:var(--subtle); border:1px solid var(--border); border-radius:8px; padding:7px 10px; border-left-width:4px; }
  .decision-card.decision-green{ border-left-color:#10b981; }
  .decision-card.decision-yellow{ border-left-color:#f59e0b; }
  .decision-card.decision-red{ border-left-color:#ef4444; }
  .decision-card-head{ display:flex; justify-content:space-between; align-items:center; margin-bottom:3px; flex-wrap:wrap; gap:4px; }
  .decision-tag{ font-size:9.5px; font-weight:700; padding:2px 6px; border-radius:5px; }
  .decision-tag.green{ background:#ecfdf5; color:#065f46; }
  .decision-tag.yellow{ background:#fffbeb; color:#92400e; }
  .decision-tag.red{ background:#fef2f2; color:#991b1b; }
  .decision-metric{ font-size:10px; font-weight:700; color:var(--text-1); }
  .decision-meaning{ font-size:9.5px; color:var(--text-2); margin-bottom:5px; line-height:1.4; }
  .decision-action{ font-size:9.5px; color:var(--text-1); background:#fff; border:1px solid var(--border); border-radius:6px; padding:5px 8px; line-height:1.4; }

  /* Footer */
  .footer{ display:flex; justify-content:space-between; align-items:center; padding:12px 40px; border-top:1px solid var(--border); background:var(--subtle); }
  .footer-brand{ display:flex; align-items:center; gap:8px; font-size:10px; font-weight:800; color:var(--ink); letter-spacing:-.2px; }
  .footer-brand .logo-badge{ width:18px; height:18px; border-radius:5px; }
  .footer-text{ font-size:9px; color:var(--text-3); font-weight:500; }

  /* Toolbar */
  .toolbar{ position:fixed; top:0; left:0; right:0; z-index:9999; background:#fff; border-bottom:1px solid var(--border); padding:11px 24px; display:flex; justify-content:space-between; align-items:center; box-shadow:0 6px 20px -10px rgba(9,9,15,.2); }
  .toolbar-text{ font-size:13px; font-weight:600; color:var(--text-1); }
  .btn{ font-family:var(--font); font-size:12px; font-weight:700; background:var(--ink); color:#fff; border:none; border-radius:9px; padding:10px 22px; cursor:pointer; }
  .btn:hover{ background:var(--ink-2); }

  @media print{
    @page { size: auto; margin: 0; }
    .no-print{ display:none!important; }
    html, body{ background:#fff!important; margin:0!important; padding:0!important; }
    .sheet{ width:100%!important; max-width:100%!important; border:none!important; border-radius:0!important; box-shadow:none!important; margin:0!important; }
    .header{ padding:14mm 40px 10mm!important; }
    .content{ padding:0 40px 14mm!important; }
    .footer{ padding:10mm 40px 14mm!important; }
    .card{ page-break-inside:auto; break-inside:auto; margin-bottom:14px; }
    .card-head, .field, .engine-logic, .two-col, .decision-card, .step, .budget-card, .intel, .cheat-sheet, .clip-card, .hook-box{ page-break-inside:avoid!important; break-inside:avoid!important; }
    .page-break-before{ page-break-before:always!important; break-before:page!important; padding-top:14mm!important; }
  }
</style>
</head>
<body>

<div class="sheet">
  <header class="header">
    <div class="header-top">
      <div class="wordmark">
        ${logoBadge}
        Omni Target
      </div>
      <div>
        <div class="badge">Advantage+ Brief</div>
        <div class="header-date">${esc(params.generatedAt)}</div>
      </div>
    </div>

    <div class="eyebrow">Meta Advantage+ AI Brief</div>
    <h1 class="h1">${esc(params.productName)}</h1>
    <div class="brand">by ${esc(params.brandName)}</div>
    ${
      params.productUrl
        ? `<div style="margin-top:6px;"><a class="prod-link" href="${esc(
            params.productUrl
          )}" target="_blank">${esc(params.productUrl)}</a></div>`
        : ""
    }

    <div class="meta-row">
      <span class="chip"><span class="chip-dot"></span>${esc(
        params.campaignGoal
      )}</span>
      <span class="chip" style="background:#4338ca;"><span class="chip-dot"></span>${esc(
        campaignType
      )}</span>
      ${params.isNewLaunch ? `<span class="chip-soft">New launch</span>` : ""}
    </div>
  </header>

  <div class="content">
    ${summaryHTML}
    ${gatewayCardHTML}
    ${adCopyHTML}
    ${creativeHooksHTML}
    ${audienceHTML}
    ${budgetHTML}
    ${timingHTML}
    ${newLaunchNoteHTML}
    ${implementationGuideHTML}
    ${params.warnings?.length
      ? card(
          "Store Context & Optimization Tips",
          `<div style="display:flex; flex-direction:column; gap:9px; font-size:11.5px; line-height:1.55; color:#475569;">
            ${params.warnings.map((w) => `<div style="display:flex; align-items:flex-start; gap:8px;">
              <span style="color:#0ea5e9; font-size:14px; line-height:1.2; flex-shrink:0;">💡</span>
              <span>${esc(w)}</span>
            </div>`).join("")}
          </div>`
        )
      : ""}
    ${decisionTreeHTML}
  </div>

  <footer class="footer">
    <div class="footer-brand">
      ${logoBadge}
      Omni Target
    </div>
    <div class="footer-text">omnitarget.co · Confidential Meta Advantage+ Campaign Brief</div>
  </footer>
</div>

${chrome}
</body>
</html>`;
}
