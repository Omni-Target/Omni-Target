/**
 * Parses referring sites, landing URLs (UTMs), and sales channel source names
 * into founder-friendly channel categories (e.g. Instagram, TikTok, Google Search, Direct).
 */
export function parseTrafficSource(
  referringSite?: string | null,
  landingSite?: string | null,
  sourceName?: string | null
): string {
  const ref = (referringSite || "").toLowerCase();
  const land = (landingSite || "").toLowerCase();
  const src = (sourceName || "").toLowerCase();

  // 1. Direct sales channel names from Shopify
  if (src === "pos") return "Point of Sale";
  if (src === "shop") return "Shopify Shop App";
  if (src === "instagram" || src === "ig") return "Instagram";
  if (src === "facebook" || src === "fb") return "Facebook";

  // 2. Check UTM parameters in landing_site
  if (
    land.includes("utm_source=instagram") ||
    land.includes("utm_source=ig") ||
    land.includes("utm_medium=instagram") ||
    land.includes("utm_medium=ig")
  ) {
    return "Instagram";
  }
  if (
    land.includes("utm_source=tiktok") ||
    land.includes("utm_medium=tiktok")
  ) {
    return "TikTok";
  }
  if (
    land.includes("utm_source=facebook") ||
    land.includes("utm_source=fb") ||
    land.includes("utm_source=meta") ||
    land.includes("utm_medium=facebook")
  ) {
    return "Facebook";
  }
  if (
    land.includes("utm_source=google") ||
    land.includes("utm_medium=cpc") ||
    land.includes("utm_source=adwords")
  ) {
    return "Google / Search";
  }
  if (land.includes("utm_source=pinterest")) {
    return "Pinterest";
  }
  if (land.includes("utm_source=youtube")) {
    return "YouTube";
  }
  if (
    land.includes("utm_medium=email") ||
    land.includes("utm_source=klaviyo") ||
    land.includes("utm_source=mailchimp") ||
    land.includes("utm_source=omnisend")
  ) {
    return "Email Marketing";
  }

  // 3. Referring site domain match
  if (ref.includes("instagram.com") || ref.includes("cdninstagram.com")) {
    return "Instagram";
  }
  if (ref.includes("tiktok.com") || ref.includes("musical.ly")) {
    return "TikTok";
  }
  if (
    ref.includes("facebook.com") ||
    ref.includes("fb.me") ||
    ref.includes("messenger.com")
  ) {
    return "Facebook";
  }
  if (ref.includes("google.") || ref.includes("googleadservices.com")) {
    return "Google / Search";
  }
  if (ref.includes("youtube.com") || ref.includes("youtu.be")) {
    return "YouTube";
  }
  if (ref.includes("pinterest.") || ref.includes("pin.it")) {
    return "Pinterest";
  }
  if (ref.includes("twitter.com") || ref.includes("x.com") || ref.includes("t.co")) {
    return "X / Twitter";
  }
  if (ref.includes("reddit.com")) {
    return "Reddit";
  }
  if (ref.includes("linkin.bio") || ref.includes("linktr.ee")) {
    return "Social Bio Link";
  }

  // 4. Direct / Organic / Fallback
  if (!ref || ref === "null" || ref === "direct" || ref === "") {
    return "Direct / Organic";
  }

  return "Web Referral";
}
