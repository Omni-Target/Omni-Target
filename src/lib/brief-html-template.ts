import { BriefPDFParams, CreativeHook } from "./brief-pdf-types";
import { getCurrencySymbol, formatCurrency } from "./currency";
import { isDomesticCity, getInternationalBudgetFloor, getEffectiveStoreCountry, getInternationalStrategies, isTier1Market } from "./market-geography";
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
} as const;

type Tone = "neutral" | "success" | "info" | "warning";

const TONE: Record<Tone, { fg: string; bg: string; bd: string }> = {
  neutral: { fg: "#09090f", bg: "#f4f4f5", bd: "#e4e4e7" },
  success: { fg: "#15803d", bg: "#f0fdf4", bd: "#c6f0d2" },
  info: { fg: "#4338ca", bg: "#eef2ff", bd: "#c7d2fe" },
  warning: { fg: "#b45309", bg: "#fffaeb", bd: "#fbe6bf" },
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
  n?: number
): string {
  const t = TONE[tone];
  return `
  <section class="card">
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
  const adSets = budget.ad_sets || 1;

  const campaignType =
    guidance?.campaign_type ?? "Manual Sales with Advantage+ Audience";
  const optimizationEvent =
    guidance?.optimization_event ??
    budget.optimization_event?.event ??
    "AddToCart";
  const optimizationReasoning =
    guidance?.optimization_reasoning ??
    budget.optimization_event?.reasoning ??
    "";

  const effectiveStoreCountry = getEffectiveStoreCountry(undefined, currency);

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
  const demographicJustification =
    seed?.demographic_justification ?? legacyTargeting.age_reasoning ?? "";

  const hooks: CreativeHook[] = params.creative_hooks ?? [];
  const warnings: string[] = Array.isArray(params.warnings)
    ? params.warnings
    : [];
  const peakDays: string[] = Array.isArray(timing.peak_days)
    ? timing.peak_days
    : [];

  // ── Product image as base64 ──
  let productImgSrc = "";
  if (gi?.currentProductImage) {
    try {
      const res = await fetch(gi.currentProductImage);
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
    const isGateway = gi.currentProductClassification === "Gateway";
    const isConsideration = gi.currentProductClassification === "Consideration";
    const isNew =
      params.isNewLaunch ||
      gi.currentProductClassification === "Insufficient Data" ||
      gi.currentProductClassification === "Unknown" ||
      !gi.currentProductClassification;

    const classTone: Tone = isGateway ? "info" : isConsideration ? "warning" : isNew ? "neutral" : "neutral";
    const classLabel = isGateway
      ? "Gateway Product"
      : isConsideration
      ? "Repeat Favorite"
      : isNew
      ? "New Arrival"
      : "All-Round Seller";

    const formatPrescription = isGateway
      ? "Try a vertical video (Reels / Stories / TikTok) showing the product in action, paired with a clean square photo."
      : isConsideration
      ? "Try a photo carousel showing close-up details, styling options, and craftsmanship."
      : "Try a vertical video (Reels/Stories) alongside a square lifestyle photo to see which one brings more sales.";

    let insightText = "";
    if (params.isNewLaunch || isNew) {
      insightText =
        "New product launch — great for testing customer interest with Meta's audience discovery.";
    } else if (
      gi.currentProductName === gi.topGatewayName &&
      gi.currentProductName === gi.bestsellerName
    ) {
      insightText =
        "This product is both your overall bestseller and your #1 Gateway product — proven to turn first-time shoppers into buyers.";
    } else if (gi.currentProductName === gi.topGatewayName) {
      insightText = `While your overall store bestseller is ${
        gi.bestsellerName || "another product"
      }, this product is your #1 Gateway product for bringing in brand-new customers.`;
    } else if (gi.currentProductName === gi.bestsellerName) {
      insightText = `This is your store's top revenue earner, with strong natural demand and steady sales.`;
    } else if (isGateway) {
      insightText =
        "Gateway product — high conversion rate with new shoppers, proven to turn ad views into first-time buyers.";
    } else if (isConsideration) {
      insightText =
        "High-value product that lifts your average cart size — best for interested shoppers and repeat buyers.";
    } else {
      insightText =
        "Reliable seller that appeals equally to brand-new shoppers and repeat customers.";
    }

    const ct = TONE[classTone] || TONE.neutral;
    gatewayCardHTML = card(
      "Product strategy & best formats",
      `
      <div class="intel">
        <div class="intel-main">
          <span class="pill" style="color:${ct.fg};background:${ct.bg};border-color:${ct.bd}">${esc(
        classLabel
      )}</span>
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
      1
    );
  }

  // ── Executive Campaign Flight Deck (Page 1 Control Panel) ──
  const primaryDomesticStr =
    domesticLocs
      .slice(0, 3)
      .map((l: any) => (l?.name || l?.city || "").split(",")[0].trim())
      .filter(Boolean)
      .join(", ") || "Nationwide Broad";

  const audienceDisplay =
    genderLabel === "Women"
      ? `Women · Ages ${ageMin}–${ageMax}`
      : genderLabel === "Men"
      ? `Men · Ages ${ageMin}–${ageMax}`
      : `Men & Women · Ages ${ageMin}–${ageMax}`;

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
        <div class="flight-metric-label">Recommended Daily Budget</div>
        <div class="flight-metric-sub">${esc(budget.tier || "Sweet Spot")} Strategy · 1 Ad Set</div>
      </div>
      <div class="flight-metric">
        <div class="flight-metric-val">${esc(optimizationEvent === "AddToCart" ? "Add to Cart" : optimizationEvent)}</div>
        <div class="flight-metric-label">What to Optimize For</div>
        <div class="flight-metric-sub">${optimizationEvent === "AddToCart" ? "Builds buyer data fast" : "Direct customer orders"}</div>
      </div>
      <div class="flight-metric">
        <div class="flight-metric-val flight-sku" title="${esc(params.productName)}">${esc(params.productName)}</div>
        <div class="flight-metric-label">Featured Product</div>
        <div class="flight-metric-sub">${params.productPrice ? `Unit Price: ${fmt(params.productPrice, currency, symbol)}` : "Store catalog focus"}</div>
      </div>
      <div class="flight-metric">
        <div class="flight-metric-val">${campaignType.includes("ASC") ? "Advantage+ (ASC)" : "Manual Sales (AI Guided)"}</div>
        <div class="flight-metric-label">Campaign Type</div>
        <div class="flight-metric-sub">${campaignType.includes("ASC") ? "Automated Shopping Campaign" : "Targeted Audience Setup"}</div>
      </div>
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
          <span class="cheat-val">${esc(optimizationEvent === "AddToCart" ? "Add to Cart" : optimizationEvent)} · Website</span>
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
          <span class="cheat-val">${duration} Days · Total ${daily ? fmt(daily * duration, currency, symbol) : "—"}</span>
        </div>
        <div class="cheat-cell">
          <span class="cheat-label">Best Time to Launch</span>
          <span class="cheat-val">Midnight (12:00 AM) before ${peakDays[0] || "peak shopping days"}</span>
        </div>
        <div class="cheat-cell">
          <span class="cheat-label">Ad Creatives to Upload</span>
          <span class="cheat-val">3 Angles (Craft &amp; Quality, Effortless Fit, Why It's Different)</span>
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

  const ANGLE_DISPLAY_MAP: Record<string, { label: string; focus: string }> = {
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
      "3 High-converting creative ad angles",
      `<p class="section-intro">3 distinct angles proven to capture feed attention and turn casual shoppers into buyers.</p>
      <div class="hooks-grid">${hooksCards}</div>`,
      ICONS.hooks,
      "neutral",
      3
    );
  }

  // ── Target Audience & Campaign Settings (Card 4) ──
  const cleanOptimizationReasoning = fixPunctuationSpacing(optimizationReasoning);
  const cleanDemographicJustification = fixPunctuationSpacing(demographicJustification);

  const audienceHTML = card(
    "Target audience & locations",
    `
    ${engineLogic(
      `Optimization Goal · ${optimizationEvent === "AddToCart" ? "Add to Cart" : optimizationEvent}`,
      `<p><strong>Why this goal:</strong> ${esc(cleanOptimizationReasoning)}</p>
       ${
         optimizationEvent === "AddToCart"
           ? `<p style="margin-top:8px; color:#fde68a;"><strong>💡 Quality Check (Cart-to-Purchase Ratio):</strong> Add to Cart ads find shoppers quickly. However, if you see over 20 cart adds without a single purchase (&lt;5% conversion), check your checkout page for unexpected shipping costs or payment issues, and switch your campaign goal to <strong>Initiate Checkout</strong> or <strong>Purchase</strong>.</p>`
           : ""
       }`
    )}

    ${field(
      isTier1 && isUS ? "Where to run ads (Advantage+ Audience)" : "Where to run ads (Local)",
      isTier1 && isUS
        ? `${tagList(["United States (Nationwide)"], "success")} ${tagList(
            domesticLocs
              .map(
                (l) =>
                  `${(l?.name || l?.city || "").split(",")[0].trim()}${
                    l?.source === "from_data" ? " ✓" : ""
                  }`
              )
              .filter(
                (c) =>
                  Boolean(c) && !c.toLowerCase().includes("united states")
              )
              .slice(0, 5)
          )}${
            domesticBudgetStr
              ? `<div style="font-size:11px; color:#4b5563; margin-top:4px;"><strong>Daily budget:</strong> ${esc(
                  domesticBudgetStr
                )} — run as 1 ad set for maximum Meta audience liquidity</div>`
              : ""
          }`
        : domesticLocs.length > 0
        ? `${tagList(
            domesticLocs
              .map(
                (l) =>
                  `${(l?.name || l?.city || "").split(",")[0].trim()}${
                    l?.source === "from_data" ? " ✓" : ""
                  }`
              )
              .filter(Boolean)
          )}${
            domesticBudgetStr
              ? `<div style="font-size:11px; color:#4b5563; margin-top:4px;"><strong>Daily budget:</strong> ${esc(
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
            `${tagList(
              intlLocs
                .map(
                  (l: { name?: string; city?: string; source?: string }) =>
                    `${(l?.name || l?.city || "").split(",")[0].trim()}${
                      l?.source === "from_data" ? " ✓" : ""
                    }`
                )
                .filter(Boolean)
            )}${
              intlBudgetStr
                ? `<div style="font-size:11px; color:#4338ca; margin-top:4px;"><strong>Optional overseas budget:</strong> ${esc(
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
        "Suggested age",
        `<span class="stat-inline">${ageMin}–${ageMax}</span>`
      )}
      ${field("Suggested gender", `<span class="stat-inline">${genderLabel === "All" ? "Men & Women" : genderLabel}</span>`)}
    </div>
    ${
      cleanDemographicJustification
        ? `<p class="reasoning">${esc(cleanDemographicJustification)}</p>`
        : ""
    }

    ${field(
      "Suggested interests (Starting hints)",
      seedInterests.length > 0
        ? tagList(seedInterests)
        : `<span class="muted">Add initial interest hints based on your niche</span>`
    )}
    <p class="guide-foot" style="text-align:left; margin-top:4px;">Meta uses these suggestions to start showing your ad to the right people. As shoppers click and buy, Meta automatically finds more customers like them.</p>`,
    ICONS.target,
    "neutral",
    4
  );

  // ── Budget (Card 5) ──
  const cleanBudgetReasoning = (() => {
    let text = budget.reasoning || "";
    if (!text) return "";
    text = fixPunctuationSpacing(text);
    const effectiveOverseas =
      intlBudgetStr ||
      (intlDaily ? `${formatCurrency(intlDaily, currency, symbol)}/day` : "");
    if (effectiveOverseas) {
      text = text.replace(
        /launch a separate overseas ad set at [^.)]+(?:\([^)]*\))?/gi,
        `launch a separate overseas ad set at ${effectiveOverseas}`
      );
    }
    return text;
  })();

  const budgetHTML = card(
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
          ${intlDaily ? fmt(intlDaily, currency, symbol) : esc(intlBudgetStr)}<span class="budget-unit">/day</span>
        </div>
        <div class="budget-card-sub">
          ${esc(intlTier)} Strategy · 1 Separate Ad Set
        </div>
        <div class="budget-meta" style="min-width:0; border-top:1px solid #e0e7ff; padding-top:8px;">
          ${row("Optional Duration", `${duration} days`)}
          ${intlDaily ? row("Estimated Test Spend", fmt(intlDaily * duration, currency, symbol)) : ""}
          ${row("Delivery", "Group into 1 ad set")}
        </div>
      </div>
    </div>

    ${engineLogic(
      "How your budget was calculated",
      `<p><strong>Two Independent Budgets:</strong> Run your <strong>Primary Local Campaign</strong> first to establish solid domestic cash flow. The <strong>Overseas Campaign</strong> is an optional suggestion to launch separately only when you want to explore international demand — never combine them into a single ad set.</p>
       ${
         currency !== "USD"
           ? `<p style="margin-top:7px; color:#cbd5e1;"><strong>💱 Ad Account Currency Tip:</strong> If your Meta Ads Manager account bills you in US Dollars ($) instead of ${esc(
               currency
             )}, enter $18/day USD directly in Ads Manager so exchange rate shifts don't lower your spend below Meta's required auction floor.</p>`
           : ""
       }
       ${
         cleanBudgetReasoning
           ? `<p style="margin-top:7px; white-space: pre-line;"><strong>Why this amount:</strong> ${esc(cleanBudgetReasoning)}</p>`
           : ""
       }`
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
        <div class="budget-meta" style="min-width:0; border-top:1px solid var(--subtle-2); padding-top:8px;">
          ${row("Test Duration", `${duration} days`)}
          ${daily ? row("Total Test Spend", fmt(daily * duration, currency, symbol)) : ""}
          ${row("Delivery", isUS ? "United States (Nationwide)" : "Core domestic sales")}
        </div>
      </div>
    </div>

    ${engineLogic(
      "How your budget was calculated",
      `<p><strong>Single Consolidated Campaign:</strong> Run as 1 Advantage+ ad set to give Meta's algorithm maximum audience liquidity and build initial pixel learning without fragmenting your spend.</p>
       ${
         currency !== "USD"
           ? `<p style="margin-top:7px; color:#cbd5e1;"><strong>💱 Ad Account Currency Tip:</strong> If your Meta Ads Manager account bills you in US Dollars ($) instead of ${esc(
               currency
             )}, enter the equivalent daily USD directly in Ads Manager so exchange rate shifts don't lower your spend below Meta's auction floor.</p>`
           : ""
       }
       ${
         cleanBudgetReasoning
           ? `<p style="margin-top:7px; white-space: pre-line;"><strong>Why this amount:</strong> ${esc(cleanBudgetReasoning)}</p>`
           : ""
       }`
    )}`
    }`,
    ICONS.budget,
    "neutral",
    5
  );

  // ── Timing & Sales Expectations (Card 6) ──
  const cleanTimingReasoning = fixPunctuationSpacing(
    timing.reasoning ||
      "Keep delivery active 24/7. Meta continuously gathers buyer interest across the week and automatically concentrates conversions during your store's peak shopping days."
  );
  const cleanTimingLaunch = fixPunctuationSpacing(timing.launch_recommendation || "");

  let timingHTML = "";
  if (peakDays.length > 0 || timing.launch_recommendation) {
    timingHTML = card(
      "When to run your ads",
      `
      ${
        cleanTimingLaunch
          ? field(
              "Launch schedule",
              `<p class="prose">${esc(cleanTimingLaunch)}</p>`
            )
          : ""
      }
      ${
        peakDays.length > 0
          ? field("Peak store buying days", tagList(peakDays, "info"))
          : ""
      }
      ${engineLogic(
        "Why ads run 24/7 (even on slower days)",
        `<p>${esc(cleanTimingReasoning)}</p>`
      )}`,
      ICONS.timing,
      "neutral",
      6
    );
  }

  // ── Warnings ──
  let warningsHTML = "";
  if (warnings.length > 0) {
    warningsHTML = card(
      "Before you launch",
      `<div class="warn-list">${warnings
        .map(
          (w) =>
            `<div class="warn-item"><span class="warn-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS.warning}</svg></span><span>${esc(
              w
            )}</span></div>`
        )
        .join("")}</div>`,
      ICONS.warning,
      "warning"
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
      title: "Campaign setup",
      instructions: campaignType.includes("ASC")
        ? "In Meta Ads Manager, click Create, select Sales, and choose Advantage+ Shopping Campaign (ASC)."
        : "In Meta Ads Manager, click Create, select Sales, and choose Manual Sales Campaign with Advantage+ Audience enabled.",
    },
    {
      level: "Ad set level" as const,
      title: "Target Audience & Conversion Setup",
      instructions: `Set conversion event to ${optimizationEvent}. In Audience Controls, enable Advantage+ Audience, set target audience to ${genderLabel === "All" ? "Men & Women" : genderLabel} (ages ${ageMin}–${ageMax}), and enter suggested interest hints.`,
    },
    {
      level: "Ad level" as const,
      title: "Creative execution",
      instructions:
        "Upload 3 creative assets mapped to the 3 Creative Angles. Paste the primary text, headline, and link description, applying the visual cue and on-screen text overlays.",
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
    <p class="guide-foot">Designed to be copied straight into Meta Ads Manager — optimized for Advantage+ broad AI targeting.</p>`,
    ICONS.guide,
    "neutral",
    7
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
  @page{ size:auto; margin:14mm 0; }
  html{ -webkit-print-color-adjust:exact!important; print-color-adjust:exact!important; background:var(--bg); }
  body{ font-family:var(--font); background:var(--bg); color:var(--text-1); font-size:11.5px; line-height:1.6; padding:32px 0 64px; }

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
  .content{ padding:28px 48px 44px; }

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
  .engine-logic{ background:linear-gradient(135deg,#090d16 0%,#151b2e 100%); color:#e2e8f0; border:1px solid #283049; border-left:4px solid #6366f1; border-radius:10px; padding:13px 16px; margin:12px 0; page-break-inside:avoid; }
  .engine-logic-head{ display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px; border-bottom:1px solid rgba(255,255,255,.1); padding-bottom:6px; }
  .engine-logic-tag{ font-size:8.5px; font-weight:800; letter-spacing:1.4px; text-transform:uppercase; color:#818cf8; font-family:monospace; }
  .engine-logic-title{ font-size:9.5px; font-weight:700; color:#cbd5e1; text-transform:uppercase; letter-spacing:.6px; }
  .engine-logic-body{ font-size:10.5px; line-height:1.6; color:#cbd5e1; }
  .engine-logic-body p{ margin-bottom:6px; } .engine-logic-body p:last-child{ margin-bottom:0; }
  .engine-logic-body strong{ color:#fff; font-weight:700; }

  /* Card */
  .card{ background:#fff; border:1px solid var(--border); border-radius:14px; margin-bottom:16px; overflow:hidden; page-break-inside:avoid; }
  .card-head{ display:flex; align-items:center; gap:11px; padding:16px 20px; border-bottom:1px solid var(--subtle-2); }
  .card-icon{ width:30px; height:30px; border-radius:8px; border:1px solid; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .card-icon svg{ width:16px; height:16px; }
  .card-label{ font-size:11px; font-weight:800; letter-spacing:1.6px; text-transform:uppercase; color:var(--text-1); }
  .card-num{ margin-left:auto; font-size:11px; font-weight:800; color:var(--text-3); letter-spacing:1px; }
  .card-body{ padding:18px 20px; }

  /* Fields */
  .field{ margin-bottom:15px; } .field:last-child{ margin-bottom:0; }
  .field-label{ font-size:8.5px; font-weight:700; letter-spacing:1.6px; text-transform:uppercase; color:var(--text-3); margin-bottom:6px; }
  .field-value{ font-size:11.5px; color:var(--text-1); line-height:1.65; }
  .headline{ font-size:17px; font-weight:800; letter-spacing:-.4px; color:var(--ink); line-height:1.25; }
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
  .hook-label{ width:85px; flex-shrink:0; font-size:8.5px; font-weight:700; text-transform:uppercase; letter-spacing:.6px; color:var(--text-3); padding-top:2px; }
  .hook-val{ color:var(--text-1); flex:1; }
  .hook-overlay{ font-family:monospace; background:rgba(245,158,11,.12); color:#b45309; padding:1px 6px; border-radius:4px; font-size:10.5px; font-weight:600; }
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
  .budget-hero{ display:flex; justify-content:space-between; align-items:flex-start; gap:20px; padding-bottom:16px; margin-bottom:16px; border-bottom:1px solid var(--subtle-2); }
  .budget-grid{ display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px; }
  @media(max-width:600px){ .budget-grid{ grid-template-columns:1fr; } }
  .budget-card{ border-radius:10px; padding:12px 14px; page-break-inside:avoid; }
  .budget-card.local{ background:var(--subtle); border:1.5px solid var(--ink); }
  .budget-card.intl{ background:#fafafe; border:1.5px dashed #6366f1; }
  .budget-card-header{ display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; }
  .budget-card-title{ font-size:9.5px; font-weight:800; text-transform:uppercase; letter-spacing:.6px; }
  .budget-card.local .budget-card-title{ color:var(--ink); }
  .budget-card.intl .budget-card-title{ color:#4338ca; }
  .budget-badge{ font-size:8px; font-weight:700; padding:2px 6px; border-radius:9999px; text-transform:uppercase; letter-spacing:.3px; }
  .budget-badge.local{ background:var(--ink); color:#fff; }
  .budget-badge.intl{ background:#ede9fe; color:#6d28d9; }
  .budget-card-amount{ font-size:22px; font-weight:800; letter-spacing:-.8px; line-height:1.1; color:var(--ink); margin-top:2px; }
  .budget-card.intl .budget-card-amount{ color:#1e1b4b; }
  .budget-card-sub{ font-size:9.5px; font-weight:600; margin-top:2px; margin-bottom:8px; }
  .budget-card.local .budget-card-sub{ color:var(--text-2); }
  .budget-card.intl .budget-card-sub{ color:#4f46e5; }
  .budget-amount{ font-size:30px; font-weight:800; letter-spacing:-1.2px; color:var(--ink); line-height:1; margin-top:4px; }
  .budget-unit{ font-size:13px; font-weight:600; color:var(--text-3); letter-spacing:0; }
  .budget-tier{ font-size:8.5px; font-weight:800; letter-spacing:1.4px; text-transform:uppercase; color:var(--text-2); margin-top:7px; }
  .budget-meta{ min-width:200px; }
  .row{ display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--subtle-2); }
  .row:last-child{ border-bottom:none; }
  .row-label{ font-size:9px; color:var(--text-3); font-weight:700; text-transform:uppercase; letter-spacing:.6px; }
  .row-value{ font-size:11px; color:var(--text-1); font-weight:700; }
  .breakdown{ background:var(--subtle); border:1px solid var(--border); border-radius:10px; padding:6px 14px; }

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

  /* Footer */
  .footer{ display:flex; justify-content:space-between; align-items:center; padding:18px 48px; border-top:1px solid var(--border); background:var(--subtle); }
  .footer-brand{ display:flex; align-items:center; gap:8px; font-size:10px; font-weight:800; color:var(--ink); letter-spacing:-.2px; }
  .footer-brand .logo-badge{ width:18px; height:18px; border-radius:5px; }
  .footer-text{ font-size:9px; color:var(--text-3); font-weight:500; }

  /* Toolbar */
  .toolbar{ position:fixed; top:0; left:0; right:0; z-index:9999; background:#fff; border-bottom:1px solid var(--border); padding:11px 24px; display:flex; justify-content:space-between; align-items:center; box-shadow:0 6px 20px -10px rgba(9,9,15,.2); }
  .toolbar-text{ font-size:13px; font-weight:600; color:var(--text-1); }
  .btn{ font-family:var(--font); font-size:12px; font-weight:700; background:var(--ink); color:#fff; border:none; border-radius:9px; padding:10px 22px; cursor:pointer; }
  .btn:hover{ background:var(--ink-2); }

  @media print{
    .no-print{ display:none!important; }
    body{ background:#fff; padding:0; }
    .sheet{ width:100%; max-width:100%; border:none; border-radius:0; box-shadow:none; }
    .header,.content{ padding-left:40px; padding-right:40px; }
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
    ${noteHTML}
    ${creativeHooksHTML}
    ${audienceHTML}
    ${budgetHTML}
    ${timingHTML}
    ${warningsHTML}
    ${newLaunchNoteHTML}
    ${implementationGuideHTML}
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
