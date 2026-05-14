export function getCurrencySymbol(
  currency: string
): string {
  const symbols: Record<string, string> = {
    NGN: "₦",
    GBP: "£",
    EUR: "€",
    USD: "$",
    CAD: "CA$",
    AUD: "A$",
    AED: "AED ",
    GHS: "GH₵",
    KES: "KSh",
    ZAR: "R",
  };
  return symbols[currency] || 
    `${currency} `;
}

export function formatCurrency(
  amount: number,
  currency: string,
  currencySymbol?: string
): string {
  const symbol = currencySymbol || getCurrencySymbol(currency);
  return `${symbol}${amount.toLocaleString()}`;
}
