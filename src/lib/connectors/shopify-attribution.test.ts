import { describe, it, expect } from "vitest";
import { parseTrafficSource } from "./traffic-source";

describe("parseTrafficSource", () => {
  it("identifies direct sales channel sources from Shopify", () => {
    expect(parseTrafficSource(null, null, "pos")).toBe("Point of Sale");
    expect(parseTrafficSource(null, null, "shop")).toBe("Shopify Shop App");
    expect(parseTrafficSource(null, null, "instagram")).toBe("Instagram");
    expect(parseTrafficSource(null, null, "facebook")).toBe("Facebook");
  });

  it("identifies UTM sources from landing URLs", () => {
    expect(
      parseTrafficSource(
        null,
        "/products/serum?utm_source=instagram&utm_medium=paid_social"
      )
    ).toBe("Instagram");

    expect(
      parseTrafficSource(
        null,
        "/collections/all?utm_source=tiktok&utm_campaign=summer_vibes"
      )
    ).toBe("TikTok");

    expect(
      parseTrafficSource(
        null,
        "/products/chair?utm_source=google&utm_medium=cpc"
      )
    ).toBe("Google / Search");

    expect(
      parseTrafficSource(
        null,
        "/cart?utm_medium=email&utm_source=klaviyo"
      )
    ).toBe("Email Marketing");
  });

  it("identifies channels from referring site domains", () => {
    expect(
      parseTrafficSource("https://l.instagram.com/", null, "web")
    ).toBe("Instagram");

    expect(
      parseTrafficSource("https://www.tiktok.com/@creator/video/123", null, "web")
    ).toBe("TikTok");

    expect(
      parseTrafficSource("https://m.facebook.com/", null, "web")
    ).toBe("Facebook");

    expect(
      parseTrafficSource("https://www.google.com/search?q=buy+skincare", null, "web")
    ).toBe("Google / Search");

    expect(
      parseTrafficSource("https://t.co/abc123xyz", null, "web")
    ).toBe("X / Twitter");

    expect(
      parseTrafficSource("https://linktr.ee/coolbrand", null, "web")
    ).toBe("Social Bio Link");
  });

  it("falls back to Direct / Organic when no referrer or landing query exists", () => {
    expect(parseTrafficSource("", "", "web")).toBe("Direct / Organic");
    expect(parseTrafficSource(null, null, "web")).toBe("Direct / Organic");
    expect(parseTrafficSource("direct", "/", "web")).toBe("Direct / Organic");
  });

  it("identifies external web referrers", () => {
    expect(
      parseTrafficSource("https://somefashionblog.com/review", "/", "web")
    ).toBe("Web Referral");
  });
});
