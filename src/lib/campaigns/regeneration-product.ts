type ProductFields = {
  productName?: string | null;
  productDescription?: string | null;
  campaignGoal?: string | null;
  productPrice?: string | null;
};

type SavedProductFields = {
  product_name: string | null;
  product_description: string | null;
  campaign_goal: string | null;
  product_price: string | null;
};

const normalizeText = (value: string | null | undefined) =>
  (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();

function normalizePrice(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  const numeric = text.replace(/[^0-9.]/g, "");
  return numeric && /^\d+(?:\.\d+)?$/.test(numeric)
    ? String(Number(numeric))
    : text.toLowerCase();
}

/** Compare before spending model tokens, then send the DB's exact saved values to the commit RPC. */
export function canonicalRegenerationProduct(
  saved: SavedProductFields,
  requested: ProductFields,
): ProductFields | null {
  const productName = saved.product_name ?? "";
  const productDescription = saved.product_description ?? "";
  const campaignGoal = saved.campaign_goal ?? "Drive Website Sales";
  const productPrice = saved.product_price;

  if (!productName ||
      (requested.productName && normalizeText(requested.productName) !== normalizeText(productName)) ||
      (requested.productDescription && normalizeText(requested.productDescription) !== normalizeText(productDescription)) ||
      (requested.campaignGoal && normalizeText(requested.campaignGoal) !== normalizeText(campaignGoal)) ||
      (requested.productPrice && normalizePrice(requested.productPrice) !== normalizePrice(productPrice))) {
    return null;
  }

  return { productName, productDescription, campaignGoal, productPrice };
}
