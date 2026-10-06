interface OrderAddressCountry {
  country?: string;
  country_code?: string;
}

interface OrderWithCountry {
  shipping_address?: OrderAddressCountry;
  billing_address?: OrderAddressCountry;
}

/** Country-level paid-order evidence when Shopify does not supply order cities. */
export function summarizeOrderCountries(orders: OrderWithCountry[]) {
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const counts = new Map<string, { country: string; order_count: number }>();

  for (const order of orders) {
    const shipping = order.shipping_address;
    const billing = order.billing_address;
    const address = shipping?.country || shipping?.country_code ? shipping : billing;
    const code = (address?.country_code || "").trim().toUpperCase();
    const rawName = (address?.country || "").trim();
    const country = rawName || (/^[A-Z]{2}$/.test(code) ? names.of(code) : "");
    if (!country || /^(unknown|null|undefined|none|-)$/i.test(country)) continue;

    const key = code || country.toLowerCase();
    const entry = counts.get(key) || { country, order_count: 0 };
    entry.order_count++;
    counts.set(key, entry);
  }

  return [...counts.values()]
    .sort((a, b) => b.order_count - a.order_count)
    .slice(0, 3);
}
