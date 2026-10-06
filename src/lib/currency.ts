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
    INR: "₹",
    JPY: "¥",
    CNY: "¥",
    SGD: "S$",
    NZD: "NZ$",
    MXN: "$",
    BRL: "R$",
    SAR: "SR ",
    CHF: "CHF ",
    SEK: "kr ",
    NOK: "kr ",
    DKK: "kr ",
    PLN: "zł ",
    TRY: "₺",
    RUB: "₽",
    EGP: "E£",
    PKR: "₨ ",
    BDT: "৳",
    PHP: "₱",
    IDR: "Rp ",
    MYR: "RM ",
    THB: "฿",
    VND: "₫",
    KRW: "₩",
    ILS: "₪",
    COP: "Col$ ",
    CLP: "$",
    PEN: "S/. ",
    ARS: "$",
    UAH: "₴",
    HUF: "Ft ",
    CZK: "Kč ",
    RON: "lei ",
    BGN: "лв ",
    HRK: "kn ",
    RSD: "din ",
    MAD: "DH ",
    DZD: "DA ",
    TND: "DT ",
    JOD: "JD ",
    OMR: "RO ",
    BHD: "BD ",
    KWD: "KD ",
    QAR: "QR ",
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
  const isZeroDecimal =
    ["NGN", "JPY", "KRW", "VND", "IDR", "CLP", "HUF", "UGX", "RWF"].includes(currency) ||
    Number.isInteger(amount);
  const formatted = isZeroDecimal
    ? Math.round(amount).toLocaleString()
    : amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return `${symbol}${formatted}`;
}
