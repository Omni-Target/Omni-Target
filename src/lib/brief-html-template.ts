import { BriefPDFParams } from "./generate-brief-pdf";
import { getCurrencySymbol, formatCurrency } from "./currency";
import fs from "fs";
import path from "path";

function esc(s: string | undefined | null): string {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmt(amount: number, currency: string, symbol?: string): string {
  return formatCurrency(amount, currency, symbol);
}

function tags(items: string[], color = "#7c3aed", bg = "rgba(124,58,237,0.12)", border = "rgba(124,58,237,0.25)"): string {
  return items.map(i => `<span class="tag" style="color:${color};background:${bg};border-color:${border}">${esc(i)}</span>`).join("");
}

function card(title: string, content: string, accentColor = "#7c3aed"): string {
  return `
  <div class="card" style="--accent:${accentColor}">
    <div class="card-accent-bar"></div>
    <div class="card-label">${esc(title)}</div>
    <div class="card-body">${content}</div>
  </div>`;
}

function row(label: string, value: string): string {
  return `<div class="row"><span class="row-label">${esc(label)}</span><span class="row-value">${value}</span></div>`;
}

function field(label: string, value: string, large = false): string {
  return `
  <div class="field">
    <div class="field-label">${esc(label)}</div>
    <div class="field-value${large ? " field-value-large" : ""}">${value}</div>
  </div>`;
}

export async function buildBriefHTML(params: BriefPDFParams): Promise<string> {
  // Load Inter font weights from disk — guarantees offline rendering, no Google Fonts CDN needed
  const fontsDir = path.join(process.cwd(), "public", "fonts");
  const loadFont = (file: string) => {
    try { return fs.readFileSync(path.join(fontsDir, file)).toString("base64"); }
    catch { return ""; }
  };
  const inter400 = loadFont("inter-400.woff2");
  const inter600 = loadFont("inter-600.woff2");
  const inter700 = loadFont("inter-700.woff2");
  const inter800 = loadFont("inter-800.woff2");
  const fontFaceCSS = [
    inter400 && `@font-face { font-family: 'Inter'; font-style: normal; font-weight: 400; src: url('data:font/woff2;base64,${inter400}') format('woff2'); }`,
    inter600 && `@font-face { font-family: 'Inter'; font-style: normal; font-weight: 600; src: url('data:font/woff2;base64,${inter600}') format('woff2'); }`,
    inter700 && `@font-face { font-family: 'Inter'; font-style: normal; font-weight: 700; src: url('data:font/woff2;base64,${inter700}') format('woff2'); }`,
    inter800 && `@font-face { font-family: 'Inter'; font-style: normal; font-weight: 800; src: url('data:font/woff2;base64,${inter800}') format('woff2'); }`,
  ].filter(Boolean).join("\n  ");

  const gi = params.gatewayInsight ?? null;
  const budget = params.budget ?? {};
  const targeting = params.targeting ?? {};
  const copy = params.copy ?? {};
  const currency = (budget as any).currency || "USD";
  const symbol = (budget as any).currency_symbol || getCurrencySymbol(currency);
  const daily = (budget as any).goal_adjusted_daily ?? (budget as any).recommended_daily ?? null;
  const duration = (budget as any).recommended_duration_days ?? 14;
  const adSets = (budget as any).ad_sets || 1;
  const locations = Array.isArray((targeting as any).locations) ? (targeting as any).locations : [];
  const interests = Array.isArray((targeting as any).interests) ? (targeting as any).interests : [];
  const behaviours = Array.isArray((targeting as any).behaviours) ? (targeting as any).behaviours : [];
  const ageMin = (targeting as any).age_min ?? 25;
  const ageMax = (targeting as any).age_max ?? 44;
  const gender = (targeting as any).gender ?? "all";
  const genderLabel = gender === "female" ? "Women" : gender === "male" ? "Men" : "All Genders";
  const warnings: string[] = Array.isArray(params.warnings) ? params.warnings : [];

  // ── Fetch product image as base64 via server-side proxy ──
  let productImgSrc = "";
  if (gi?.currentProductImage) {
    try {
      const res = await fetch(gi.currentProductImage);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const ct = res.headers.get("content-type") || "image/jpeg";
        const b64 = Buffer.from(buf).toString("base64");
        productImgSrc = `data:${ct};base64,${b64}`;
      }
    } catch { /* ignore */ }
  }

  // ── Gateway Intelligence Card ──
  let gatewayCardHTML = "";
  if (gi) {
    const isGateway = gi.currentProductClassification === "Gateway";
    const classColor = isGateway ? "#4ade80" : "#9b73ff";
    const classLabel = isGateway ? "Gateway Product" : gi.currentProductClassification === "Consideration" ? "Consideration Product" : "Hybrid Product";
    const formatPrescription = isGateway 
      ? "We recommend leading with a UGC video showing the product in use." 
      : gi.currentProductClassification === "Consideration" 
        ? "We recommend a Carousel or a Founder-Led video to build trust." 
        : "We recommend testing a UGC video against a Carousel to see what resonates.";

    let insightText = "";
    if (gi.currentProductName === gi.topGatewayName && gi.currentProductName === gi.bestsellerName) {
      insightText = "This product is both your organic bestseller and your strongest cold-traffic converter.";
    } else if (gi.currentProductName === gi.topGatewayName) {
      insightText = `While your organic bestseller is ${gi.bestsellerName || "another product"}, this is your top Gateway Product — the strongest cold-traffic converter in your store.`;
    } else if (gi.currentProductName === gi.bestsellerName) {
      insightText = `This is your organic bestseller, but your top cold-traffic Gateway Product is ${gi.topGatewayName || "another product"}.`;
    } else {
      insightText = `This is a ${gi.currentProductClassification} Product. Your bestseller is ${gi.bestsellerName || "another product"}, and your top Gateway Product is ${gi.topGatewayName || "another product"}.`;
    }

    const imgBlock = productImgSrc
      ? `<img class="product-img" src="${productImgSrc}" alt="Product"/>`
      : "";

    gatewayCardHTML = card("Store Intelligence", `
      <div class="intel-layout">
        <div class="intel-content">
          <div class="classification-badge" style="color:${classColor};border-color:${classColor}40;background:${classColor}12">${esc(classLabel)}</div>
          ${field("Strategy Insight", `<p class="prose">${esc(insightText)}</p>`)}
          ${field("Creative Direction", `<span class="highlight">${esc(formatPrescription)}</span>`)}
        </div>
        ${imgBlock ? `<div class="intel-img">${imgBlock}</div>` : ""}
      </div>
    `, "#9b73ff");
  }

  // ── Ad Copy Card ──
  const adCopyHTML = card("Ad Copy", `
    ${field("Headline", `<p class="prose prose-white prose-xl">${esc((copy as any).headline)}</p>`, true)}
    ${field("Primary Text", `<p class="prose">${esc((copy as any).primaryText)}</p>`)}
    ${field("Link Description", `<p class="prose">${esc((copy as any).description)}</p>`)}
    ${field("Call to Action", `<span class="cta-badge">${esc((copy as any).cta)}</span>`)}
  `);

  // ── Copywriter's Note ──
  const noteHTML = `
  <div class="note-card">
    <div class="note-bar"></div>
    <div class="note-inner">
      <div class="note-label">Copywriter's Note</div>
      <p class="note-text">"${esc((copy as any).copywriterNote)}"</p>
    </div>
  </div>`;

  // ── Targeting Card ──
  const safeLocations = Array.isArray(locations) ? locations : [];
  const targetingHTML = card("Audience Targeting", `
    ${field("Locations", safeLocations.length > 0
      ? tags(safeLocations.map(l => `${(l?.name || l?.city || "").split(',')[0].trim()}${l?.source === "from_data" ? " ✓" : ""}`).filter(Boolean))
      : `<span class="muted">Set manually in Meta Ads Manager</span>`)}
    <div class="two-col">
      ${field("Age Range", `<span class="stat">${ageMin}–${ageMax}</span>`)}
      ${field("Gender", `<span class="stat">${genderLabel}</span>`)}
    </div>
    ${(targeting as any).age_reasoning ? `<p class="reasoning">${esc((targeting as any).age_reasoning)}</p>` : ""}
    ${field("Interests", interests.length > 0 ? tags(interests) : `<span class="muted">Add manually based on your niche</span>`)}
    ${field("Behaviours", behaviours.length > 0
      ? tags(behaviours, "#4ade80", "rgba(74,222,128,0.1)", "rgba(74,222,128,0.25)")
      : tags(["Engaged Shoppers", "Online Shoppers"], "#4ade80", "rgba(74,222,128,0.1)", "rgba(74,222,128,0.25)"))}
  `);

  // ── Budget Card ──
  const budgetHTML = card("Budget & Strategy", `
    <div class="budget-hero">
      <div>
        <div class="field-label">Daily Budget</div>
        <div class="budget-amount">${daily ? fmt(daily, currency, symbol) : "Set Manually"}<span class="budget-unit">/day</span></div>
        ${(budget as any).tier ? `<div class="budget-tier">${esc((budget as any).tier)} Strategy</div>` : ""}
      </div>
      <div class="budget-meta">
        ${row("Duration", `${duration} days`)}
        ${daily ? row("Total Test Spend", fmt(daily * duration, currency, symbol)) : ""}
        ${row("Ad Sets", `${adSets} max`)}
      </div>
    </div>
    ${(budget as any).optimization_event ? `
      ${field("Optimization Event", `<span class="highlight">${esc((budget as any).optimization_event.event)}</span>`)}
      <p class="reasoning">${esc((budget as any).optimization_event.reasoning)}</p>
    ` : ""}
    ${(budget as any).breakdown ? `
      ${field("How This Was Calculated", `
        <div class="breakdown-grid">
          ${row("Revenue Signal", fmt((budget as any).breakdown.revenue_based, currency, symbol) + "/day")}
          ${row("AOV Signal", fmt((budget as any).breakdown.aov_based, currency, symbol))}
          ${(budget as any).goal_label ? row("Goal Adjustment", `Adjusted for ${(budget as any).goal_label}`) : ""}
        </div>
      `)}
    ` : ""}
    ${(budget as any).reasoning ? field("Strategy Context", `<p class="prose muted-prose">${esc((budget as any).reasoning)}</p>`) : ""}
  `);

  // ── Timing Card ──
  const timing = params.timing ?? {};
  const peakDays: string[] = Array.isArray((timing as any).peak_days) ? (timing as any).peak_days : [];
  let timingHTML = "";
  if (peakDays.length > 0 || (timing as any).launch_recommendation) {
    timingHTML = card("Timing", `
      ${(timing as any).launch_recommendation ? field("Launch Recommendation", `<p class="prose">${esc((timing as any).launch_recommendation)}</p>`) : ""}
      ${peakDays.length > 0 ? field("Best Days to Run", tags(peakDays, "#60a5fa", "rgba(96,165,250,0.1)", "rgba(96,165,250,0.25)")) : ""}
    `, "#3b82f6");
  }

  // ── Warnings (Omitted by user request) ──
  let warningsHTML = "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Campaign Brief — ${esc(params.productName)}</title>
<style>
  ${fontFaceCSS}
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0a0a0f;
    --surface: #111118;
    --card: #131320;
    --border: #22223a;
    --accent: #7c3aed;
    --accent-glow: rgba(124,58,237,0.15);
    --text-1: #ffffff;
    --text-2: #a1a1aa;
    --text-3: #8b8b9e;
    --white: #ffffff;
    --success: #4ade80;
    --warning: #f59e0b;
    --info: #60a5fa;
    --font: 'Inter', -apple-system, sans-serif;
  }

  @page { size: A4; margin: 0; }

  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--text-1);
    font-size: 11px;
    line-height: 1.6;
    min-height: 100vh;
  }

  /* ── Header ── */
  .header {
    background: linear-gradient(135deg, #0d0d1a 0%, #130e24 50%, #0d0d1a 100%);
    padding: 40px 48px 36px;
    position: relative;
    overflow: hidden;
    border-bottom: 1px solid var(--border);
  }
  .header::before {
    content: '';
    position: absolute;
    top: -60px; right: -80px;
    width: 300px; height: 300px;
    background: radial-gradient(circle, rgba(124,58,237,0.18) 0%, transparent 70%);
    pointer-events: none;
  }
  .header-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 32px; }
  .wordmark { font-size: 18px; font-weight: 800; color: var(--white); letter-spacing: -0.5px; display: flex; align-items: center; gap: 6px; }
  .wordmark-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); display: inline-block; }
  .header-badge {
    font-size: 8px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase;
    color: var(--accent); border: 1px solid rgba(124,58,237,0.35);
    background: rgba(124,58,237,0.08); padding: 5px 12px; border-radius: 100px;
  }
  .header-date { font-size: 8px; color: var(--text-3); font-weight: 500; margin-top: 4px; }
  .header-product { font-size: 30px; font-weight: 900; color: var(--white); letter-spacing: -1px; line-height: 1.1; margin-bottom: 10px; }
  .header-brand { font-size: 12px; color: var(--text-2); font-weight: 500; margin-bottom: 16px; }
  .header-goal {
    display: inline-flex; align-items: center; gap: 8px;
    background: rgba(124,58,237,0.1); border: 1px solid rgba(124,58,237,0.25);
    border-radius: 8px; padding: 8px 14px;
  }
  .header-goal-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
  .header-goal-text { font-size: 10px; font-weight: 600; color: #c4b5fd; }
  .header-bar { height: 3px; background: linear-gradient(90deg, var(--accent) 0%, #a78bfa 60%, transparent 100%); margin-top: 32px; border-radius: 2px; }

  /* ── Content ── */
  .content { padding: 40px 48px 60px; }
  .section-gap { height: 16px; }

  /* ── Cards ── */
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    margin-bottom: 16px;
    position: relative;
    page-break-inside: avoid;
  }
  .card-accent-bar {
    height: 3px;
    background: linear-gradient(90deg, var(--accent) 0%, rgba(124,58,237,0.2) 100%);
  }
  .card-label {
    font-size: 8.5px; font-weight: 800; letter-spacing: 2.5px; text-transform: uppercase;
    color: var(--text-2); padding: 16px 20px 0;
  }
  .card-body { padding: 12px 20px 20px; }

  /* ── Fields ── */
  .field { margin-bottom: 16px; }
  .field:last-child { margin-bottom: 0; }
  .field-label {
    font-size: 8px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase;
    color: var(--text-2); margin-bottom: 5px;
  }
  .field-value { font-size: 11.5px; color: var(--text-1); line-height: 1.6; }
  .field-value-large .prose-xl { font-size: 15px !important; font-weight: 700 !important; color: var(--white) !important; }

  .two-col { display: flex; gap: 24px; margin-bottom: 0; }
  .two-col .field { flex: 1; }

  /* ── Text styles ── */
  .prose { font-size: 11.5px; line-height: 1.7; color: var(--text-1); }
  .prose-white { color: var(--white); }
  .muted { color: var(--text-2); font-style: italic; font-size: 11px; }
  .muted-prose { color: var(--text-2); }
  .stat { font-size: 15px; font-weight: 700; color: var(--white); }
  .highlight { font-size: 12.5px; font-weight: 700; color: #ddd6fe; }
  .reasoning { font-size: 10px; color: var(--text-2); line-height: 1.6; margin-top: 6px; margin-bottom: 12px; }

  /* ── Tags ── */
  .tag {
    display: inline-block; font-size: 9.5px; font-weight: 600;
    border: 1px solid; border-radius: 100px;
    padding: 4px 12px; margin: 2px 3px 2px 0;
  }

  /* ── CTA Badge ── */
  .cta-badge {
    display: inline-block; font-size: 11px; font-weight: 700;
    background: linear-gradient(135deg, rgba(124,58,237,0.2), rgba(167,139,250,0.15));
    border: 1px solid rgba(124,58,237,0.35); border-radius: 8px;
    padding: 6px 14px; color: #ddd6fe; letter-spacing: 0.3px;
  }

  /* ── Classification Badge ── */
  .classification-badge {
    display: inline-block; font-size: 10px; font-weight: 800; letter-spacing: 1px;
    text-transform: uppercase; border: 1px solid; border-radius: 100px;
    padding: 4px 12px; margin-bottom: 14px;
  }

  /* ── Store Intelligence ── */
  .intel-layout { display: flex; gap: 20px; align-items: flex-start; }
  .intel-content { flex: 1; }
  .intel-img { flex-shrink: 0; }
  .product-img {
    width: 90px; height: 90px; object-fit: cover;
    border-radius: 10px; border: 1px solid var(--border);
    display: block;
  }

  /* ── Copywriter's Note ── */
  .note-card {
    background: #0c0c18; border: 1px solid var(--border);
    border-radius: 14px; overflow: hidden;
    margin-bottom: 16px; display: flex;
    page-break-inside: avoid;
  }
  .note-bar { width: 3px; background: linear-gradient(180deg, var(--accent) 0%, #a78bfa 100%); flex-shrink: 0; }
  .note-inner { padding: 16px 20px 18px; }
  .note-label {
    font-size: 8.5px; font-weight: 800; letter-spacing: 2.5px;
    text-transform: uppercase; color: var(--text-2); margin-bottom: 10px;
  }
  .note-text { font-size: 11px; font-style: italic; color: var(--text-2); line-height: 1.8; }

  /* ── Budget ── */
  .budget-hero { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
  .budget-amount { font-size: 28px; font-weight: 900; color: var(--white); letter-spacing: -1px; line-height: 1; margin: 4px 0; }
  .budget-unit { font-size: 14px; font-weight: 500; color: var(--text-2); }
  .budget-tier { font-size: 9px; font-weight: 700; color: var(--accent); letter-spacing: 1.5px; text-transform: uppercase; margin-top: 4px; }
  .budget-meta { text-align: right; }
  .row { display: flex; justify-content: space-between; align-items: center; padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .row:last-child { border-bottom: none; }
  .row-label { font-size: 9px; color: var(--text-2); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .row-value { font-size: 10.5px; color: var(--text-1); font-weight: 600; }
  .breakdown-grid { background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; }

  /* ── Warnings ── */
  .warn-list { display: flex; flex-direction: column; gap: 10px; }
  .warn-item { display: flex; align-items: flex-start; gap: 10px; }
  .warn-icon {
    flex-shrink: 0; width: 18px; height: 18px; border-radius: 50%;
    background: rgba(245,158,11,0.15); border: 1px solid rgba(245,158,11,0.3);
    color: #f59e0b; font-size: 9px; font-weight: 900;
    display: flex; align-items: center; justify-content: center;
  }
  .warn-item span:last-child { font-size: 9.5px; color: #fcd34d; line-height: 1.6; padding-top: 1px; }

  /* ── Footer ── */
  .footer {
    position: fixed; bottom: 0; left: 0; right: 0;
    background: var(--bg); border-top: 1px solid var(--border);
    padding: 10px 48px;
    display: flex; justify-content: space-between; align-items: center;
  }
  .footer-text { font-size: 7px; color: var(--text-3); font-weight: 500; }
  .footer-brand { font-size: 7px; font-weight: 800; color: var(--text-3); letter-spacing: 1px; text-transform: uppercase; }

  /* ── Print Toolbar ── */
  .print-toolbar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    border-bottom: 1px solid var(--border);
    padding: 12px 48px;
    display: flex; justify-content: space-between; align-items: center;
    box-shadow: 0 4px 24px rgba(0,0,0,0.4);
  }
  .print-toolbar-text { font-size: 13px; font-weight: 600; color: var(--text-1); }
  .print-btn {
    font-family: var(--font); font-size: 12px; font-weight: 700;
    background: linear-gradient(135deg, #7c3aed, #a78bfa); color: #fff;
    border: none; border-radius: 8px; padding: 10px 24px; cursor: pointer;
    transition: opacity 0.2s;
  }
  .print-btn:hover { opacity: 0.85; }

  /* ── Print Overrides ── */
  @media print {
    .no-print { display: none !important; }
    body { padding-top: 0 !important; }
    .header { margin-top: 0; }
  }
</style>
</head>
<body>

<header class="header">
  <div class="header-top">
    <div>
      <div class="wordmark">Omni Target<span class="wordmark-dot"></span></div>
      <div class="header-date">${esc(params.generatedAt)}</div>
    </div>
    <div class="header-badge">Campaign Brief</div>
  </div>

  <div class="header-product">${esc(params.productName)}</div>
  <div class="header-brand">by ${esc(params.brandName)}</div>
  <div class="header-goal">
    <span class="header-goal-dot"></span>
    <span class="header-goal-text">${esc(params.campaignGoal)}</span>
  </div>
  <div class="header-bar"></div>
</header>

<div class="content">
  ${gatewayCardHTML}
  ${adCopyHTML}
  ${noteHTML}
  ${targetingHTML}
  ${budgetHTML}
  ${timingHTML}
  ${warningsHTML}
</div>

<footer class="footer no-print">
  <div class="footer-brand">Omni Target</div>
  <div class="footer-text">omnitarget.co — Confidential Campaign Brief</div>
</footer>

<div class="print-toolbar no-print">
  <span class="print-toolbar-text">Your campaign brief is ready</span>
  <button class="print-btn" onclick="window.print()">⬇ Save as PDF</button>
</div>

</body>
</html>`;
}
