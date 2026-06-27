import { BriefPDFParams } from "./generate-brief-pdf";
import { getCurrencySymbol, formatCurrency } from "./currency";
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
  info: { fg: "#1d4ed8", bg: "#eff6ff", bd: "#cfe0fd" },
  warning: { fg: "#b45309", bg: "#fffaeb", bd: "#fbe6bf" },
};

function tagList(items: string[], tone: Tone = "neutral"): string {
  const t = TONE[tone];
  return items
    .map(
      (i) =>
        `<span class="tag" style="color:${t.fg};background:${t.bg};border-color:${t.bd}">${esc(i)}</span>`,
    )
    .join("");
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

export async function buildBriefHTML(params: BriefPDFParams): Promise<string> {
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
  const fontFaceCSS = [
    inter400 && `@font-face{font-family:'Inter';font-style:normal;font-weight:400;src:url('data:font/woff2;base64,${inter400}') format('woff2');}`,
    inter600 && `@font-face{font-family:'Inter';font-style:normal;font-weight:600;src:url('data:font/woff2;base64,${inter600}') format('woff2');}`,
    inter700 && `@font-face{font-family:'Inter';font-style:normal;font-weight:700;src:url('data:font/woff2;base64,${inter700}') format('woff2');}`,
    inter800 && `@font-face{font-family:'Inter';font-style:normal;font-weight:800;src:url('data:font/woff2;base64,${inter800}') format('woff2');}`,
  ]
    .filter(Boolean)
    .join("\n  ");

  // ── Data extraction (unchanged contract) ──
  const gi = params.gatewayInsight ?? null;
  const budget = params.budget ?? ({} as BriefPDFParams["budget"]);
  const targeting = params.targeting ?? ({} as BriefPDFParams["targeting"]);
  const copy = params.copy ?? ({} as BriefPDFParams["copy"]);
  const timing = params.timing ?? ({} as BriefPDFParams["timing"]);
  const currency = budget.currency || "USD";
  const symbol = budget.currency_symbol || getCurrencySymbol(currency);
  const daily = budget.goal_adjusted_daily ?? budget.recommended_daily ?? null;
  const duration = budget.recommended_duration_days ?? 14;
  const adSets = budget.ad_sets || 1;
  const locations = Array.isArray(targeting.locations) ? targeting.locations : [];
  const interests = Array.isArray(targeting.interests) ? targeting.interests : [];
  const behaviours = Array.isArray(targeting.behaviours) ? targeting.behaviours : [];
  const ageMin = targeting.age_min ?? 25;
  const ageMax = targeting.age_max ?? 44;
  const gender = targeting.gender ?? "all";
  const genderLabel = gender === "female" ? "Women" : gender === "male" ? "Men" : "All genders";
  const warnings: string[] = Array.isArray(params.warnings) ? params.warnings : [];
  const peakDays: string[] = Array.isArray(timing.peak_days) ? timing.peak_days : [];

  // ── Product image as base64 ──
  let productImgSrc = "";
  if (gi?.currentProductImage) {
    try {
      const res = await fetch(gi.currentProductImage);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const ct = res.headers.get("content-type") || "image/jpeg";
        productImgSrc = `data:${ct};base64,${Buffer.from(buf).toString("base64")}`;
      }
    } catch {
      /* ignore */
    }
  }

  // ── Store Intelligence content ──
  let gatewayCardHTML = "";
  if (gi) {
    const isGateway = gi.currentProductClassification === "Gateway";
    const isConsideration = gi.currentProductClassification === "Consideration";
    const classTone: Tone = isGateway ? "success" : "neutral";
    const classLabel = isGateway
      ? "Gateway Product"
      : isConsideration
        ? "Consideration Product"
        : "Hybrid Product";
    const formatPrescription = isGateway
      ? "We recommend leading with a UGC video showing the product in use."
      : isConsideration
        ? "We recommend a Carousel or a Founder-Led video to build trust."
        : "We recommend testing a UGC video against a Carousel to see what resonates.";

    let insightText = "";
    if (params.isNewLaunch) {
      insightText = "New product — targeting built from your store's buyer profile.";
    } else if (gi.currentProductName === gi.topGatewayName && gi.currentProductName === gi.bestsellerName) {
      insightText = "This product is both your organic bestseller and your strongest cold-traffic converter.";
    } else if (gi.currentProductName === gi.topGatewayName) {
      insightText = `While your organic bestseller is ${gi.bestsellerName || "another product"}, this is your top Gateway Product — the strongest cold-traffic converter in your store.`;
    } else if (gi.currentProductName === gi.bestsellerName) {
      insightText = `This is your organic bestseller, but your top cold-traffic Gateway Product is ${gi.topGatewayName || "another product"}.`;
    } else {
      const clsName =
        gi.currentProductClassification === "Insufficient Data"
          ? "Insufficient Data"
          : gi.currentProductClassification === "Unknown" || !gi.currentProductClassification
            ? "Hybrid"
            : gi.currentProductClassification;
      const article = clsName === "Insufficient Data" || clsName === "Unknown" ? "an" : "a";
      insightText = `This is ${article} ${clsName} Product. Your bestseller is ${gi.bestsellerName || "another product"}, and your top Gateway Product is ${gi.topGatewayName || "another product"}.`;
    }

    const ct = TONE[classTone];
    gatewayCardHTML = card(
      "Store intelligence",
      `
      <div class="intel">
        <div class="intel-main">
          <span class="pill" style="color:${ct.fg};background:${ct.bg};border-color:${ct.bd}">${esc(classLabel)}</span>
          ${field("Strategy insight", `<p class="prose">${esc(insightText)}</p>`)}
          <div class="callout callout-info">
            <div class="callout-label">Creative direction</div>
            <p>${esc(formatPrescription)}</p>
          </div>
        </div>
        ${productImgSrc ? `<div class="intel-img"><img src="${productImgSrc}" alt="Product"/></div>` : ""}
      </div>`,
      ICONS.intel,
      "neutral",
      1,
    );
  }

  // ── At-a-glance summary ──
  const stat = (label: string, value: string, sub = "") =>
    `<div class="stat"><div class="stat-value">${value}</div><div class="stat-label">${esc(label)}</div>${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ""}</div>`;
  const summaryTiles = [
    daily ? stat("Daily budget", fmt(daily, currency, symbol), budget.tier ? `${budget.tier} strategy` : "") : "",
    stat("Test window", `${duration} days`, daily ? `Total ${fmt(daily * duration, currency, symbol)}` : ""),
    stat("Audience", `${ageMin}–${ageMax}`, genderLabel),
    budget.optimization_event ? stat("Optimize for", esc(budget.optimization_event.event)) : stat("Ad sets", `${adSets}`),
  ]
    .filter(Boolean)
    .join("");
  const summaryHTML = `
  <section class="summary">
    <div class="summary-head">
      <span class="summary-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS.gauge}</svg></span>
      <span>Campaign at a glance</span>
    </div>
    <div class="stat-grid">${summaryTiles}</div>
  </section>`;

  // ── Ad Copy ──
  const adCopyHTML = card(
    "Ad copy",
    `
    ${field("Headline", `<p class="prose headline">${esc(copy.headline)}</p>`, true)}
    <div class="hr"></div>
    ${field("Primary text", `<p class="prose">${esc(copy.primaryText)}</p>`)}
    ${field("Link description", `<p class="prose">${esc(copy.description)}</p>`)}
    ${field("Call to action", `<span class="cta-badge">${esc(copy.cta)}</span>`)}`,
    ICONS.copy,
    "neutral",
    2,
  );

  // ── Copywriter's Note (quote block) ──
  const noteHTML = `
  <section class="quote">
    <span class="quote-mark">&ldquo;</span>
    <div class="quote-body">
      <div class="quote-label">Copywriter's note</div>
      <p class="quote-text">${esc(copy.copywriterNote)}</p>
    </div>
  </section>`;

  // ── Targeting ──
  const targetingHTML = card(
    "Audience targeting",
    `
    ${field(
      "Locations",
      locations.length > 0
        ? tagList(
            locations
              .map((l) => `${(l?.name || l?.city || "").split(",")[0].trim()}${l?.source === "from_data" ? " ✓" : ""}`)
              .filter(Boolean),
          )
        : `<span class="muted">Set manually in Meta Ads Manager</span>`,
    )}
    <div class="two-col">
      ${field("Age range", `<span class="stat-inline">${ageMin}–${ageMax}</span>`)}
      ${field("Gender", `<span class="stat-inline">${genderLabel}</span>`)}
    </div>
    ${targeting.age_reasoning ? `<p class="reasoning">${esc(targeting.age_reasoning)}</p>` : ""}
    ${field("Interests", interests.length > 0 ? tagList(interests) : `<span class="muted">Add manually based on your niche</span>`)}
    ${field("Behaviours", tagList(behaviours.length > 0 ? behaviours : ["Engaged Shoppers"], "success"))}`,
    ICONS.target,
    "neutral",
    3,
  );

  // ── Budget ──
  const budgetHTML = card(
    "Budget & strategy",
    `
    <div class="budget-hero">
      <div>
        <div class="field-label">Daily budget</div>
        <div class="budget-amount">${daily ? fmt(daily, currency, symbol) : "Set manually"}<span class="budget-unit">/day</span></div>
        ${budget.tier ? `<div class="budget-tier">${esc(budget.tier)} strategy</div>` : ""}
      </div>
      <div class="budget-meta">
        ${row("Duration", `${duration} days`)}
        ${daily ? row("Total test spend", fmt(daily * duration, currency, symbol)) : ""}
        ${row("Ad sets", `${adSets} max`)}
      </div>
    </div>
    ${
      budget.optimization_event
        ? `<div class="callout callout-info"><div class="callout-label">Optimization event · ${esc(budget.optimization_event.event)}</div><p>${esc(budget.optimization_event.reasoning)}</p></div>`
        : ""
    }
    ${
      budget.breakdown
        ? field(
            "How this was calculated",
            `<div class="breakdown">
          ${row("Revenue signal", fmt(budget.breakdown.revenue_based, currency, symbol) + "/month")}
          ${row("AOV signal", fmt(budget.breakdown.aov_based, currency, symbol))}
          ${budget.goal_label ? row("Goal adjustment", `Adjusted for ${esc(budget.goal_label)}`) : ""}
        </div>`,
          )
        : ""
    }
    ${budget.reasoning ? field("Strategy context", `<p class="prose muted-prose">${esc(budget.reasoning)}</p>`) : ""}`,
    ICONS.budget,
    "neutral",
    4,
  );

  // ── Timing ──
  let timingHTML = "";
  if (peakDays.length > 0 || timing.launch_recommendation) {
    timingHTML = card(
      "Timing",
      `
      ${timing.launch_recommendation ? field("Launch recommendation", `<p class="prose">${esc(timing.launch_recommendation)}</p>`) : ""}
      ${peakDays.length > 0 ? field("Best days to run", tagList(peakDays, "info")) : ""}`,
      ICONS.timing,
      "info",
      5,
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
            `<div class="warn-item"><span class="warn-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS.warning}</svg></span><span>${esc(w)}</span></div>`,
        )
        .join("")}</div>`,
      ICONS.warning,
      "warning",
    );
  }

  // ── New launch note ──
  const newLaunchNoteHTML = params.isNewLaunch
    ? `<div class="callout callout-success callout-standalone"><span class="callout-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS.rocket}</svg></span><div><div class="callout-label">New launch</div><p>Targeting is built from your store's buyer profile — refine it after your first 10 orders.</p></div></div>`
    : "";

  // ── Implementation guide ──
  const steps = [
    {
      t: "Campaign level",
      d: `Go to Meta Ads Manager, click <strong>Create</strong>, and choose the <strong>Sales</strong> objective.`,
    },
    {
      t: "Ad set level",
      d: `Paste your <strong>locations, age, gender, and interests</strong> from the Audience section. Set your optimization event to <strong>${esc(budget.optimization_event?.event || "Purchases")}</strong> and enter your budget.`,
    },
    {
      t: "Ad level",
      d: `Upload your <strong>creative assets</strong> (UGC video or product images). Paste the <strong>primary text, headline, and link description</strong>, then add your product link to the destination URL.`,
    },
  ];
  const implementationGuideHTML = card(
    "Meta Ads implementation guide",
    `<div class="steps">${steps
      .map(
        (s, i) =>
          `<div class="step"><span class="step-num">${i + 1}</span><div><div class="step-title">${s.t}</div><div class="step-desc">${s.d}</div></div></div>`,
      )
      .join("")}</div>
    <p class="guide-foot">Designed to be copied straight into Meta Ads Manager — no guesswork.</p>`,
    ICONS.guide,
    "neutral",
    6,
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Campaign Brief — ${esc(params.productName)}</title>
<style>
  ${fontFaceCSS}
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  :root{
    --ink:#09090f; --ink-2:#2c2c34;
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
  .logo-badge{ width:26px; height:26px; border-radius:7px; background:var(--ink); display:flex; align-items:center; justify-content:center; }
  .logo-badge svg{ width:16px; height:16px; }
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

  /* Summary */
  .summary{ border:1px solid var(--border); background:var(--subtle); border-radius:14px; padding:18px 20px; margin-bottom:18px; page-break-inside:avoid; }
  .summary-head{ display:flex; align-items:center; gap:9px; font-size:9px; font-weight:800; letter-spacing:2px; text-transform:uppercase; color:var(--text-2); margin-bottom:14px; }
  .summary-icon{ color:var(--ink); }
  .summary-icon svg{ width:15px; height:15px; }
  .stat-grid{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }
  .stat{ background:#fff; border:1px solid var(--border); border-radius:10px; padding:13px 14px; }
  .stat-value{ font-size:18px; font-weight:800; letter-spacing:-.5px; color:var(--ink); line-height:1.1; }
  .stat-label{ font-size:8.5px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:var(--text-3); margin-top:6px; }
  .stat-sub{ font-size:9.5px; color:var(--text-2); margin-top:3px; }

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
  .budget-amount{ font-size:30px; font-weight:800; letter-spacing:-1.2px; color:var(--ink); line-height:1; margin-top:4px; }
  .budget-unit{ font-size:14px; font-weight:600; color:var(--text-3); letter-spacing:0; }
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
  .footer-brand .logo-badge{ width:18px; height:18px; border-radius:5px; } .footer-brand .logo-badge svg{ width:11px; height:11px; }
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
        <span class="logo-badge">
          <svg viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="16" r="9" stroke="#fff" stroke-width="2" stroke-opacity="0.5"/>
            <path d="M16 7a9 9 0 0 1 9 9" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
            <circle cx="16" cy="16" r="4" stroke="#fff" stroke-width="2"/>
            <circle cx="16" cy="16" r="1.6" fill="#fff"/>
          </svg>
        </span>
        Omni Target
      </div>
      <div>
        <div class="badge">Campaign Brief</div>
        <div class="header-date">${esc(params.generatedAt)}</div>
      </div>
    </div>

    <div class="eyebrow">AI Marketing Brief</div>
    <h1 class="h1">${esc(params.productName)}</h1>
    <div class="brand">by ${esc(params.brandName)}</div>
    ${params.productUrl ? `<div style="margin-top:6px;"><a class="prod-link" href="${esc(params.productUrl)}" target="_blank">${esc(params.productUrl)}</a></div>` : ""}

    <div class="meta-row">
      <span class="chip"><span class="chip-dot"></span>${esc(params.campaignGoal)}</span>
      ${params.isNewLaunch ? `<span class="chip-soft">New launch</span>` : ""}
    </div>
  </header>

  <div class="content">
    ${summaryHTML}
    ${gatewayCardHTML}
    ${adCopyHTML}
    ${noteHTML}
    ${targetingHTML}
    ${budgetHTML}
    ${timingHTML}
    ${warningsHTML}
    ${newLaunchNoteHTML}
    ${implementationGuideHTML}
  </div>

  <footer class="footer">
    <div class="footer-brand">
      <span class="logo-badge"><svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="9" stroke="#fff" stroke-width="2.5" stroke-opacity="0.5"/><circle cx="16" cy="16" r="4" stroke="#fff" stroke-width="2.5"/><circle cx="16" cy="16" r="1.8" fill="#fff"/></svg></span>
      Omni Target
    </div>
    <div class="footer-text">omnitarget.co · Confidential campaign brief</div>
  </footer>
</div>

<div class="toolbar no-print">
  <span class="toolbar-text">Your campaign brief is ready</span>
  <button class="btn" onclick="window.print()">Save as PDF</button>
</div>

<script>
  window.onload = function () {
    setTimeout(function () { window.print(); }, 800);
  };
</script>
</body>
</html>`;
}
