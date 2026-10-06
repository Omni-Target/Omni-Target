import { getForbiddenSiblingProducts } from "@/lib/validate-brief";
import type { ProductFactualEvidence } from "./factual-claims";

interface CopyEvidenceProduct {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  product_type?: string;
}

/** Keep copy validation aligned with the product evidence sent to the model. */
export function buildCopyValidationEvidence(
  target: CopyEvidenceProduct,
  catalog: Array<Pick<CopyEvidenceProduct, "id" | "name">>,
  catalogClaims = "",
  storeCountry = "",
) {
  const provenanceEvidence = storeCountry ? `Made in ${storeCountry}. Designed in ${storeCountry}.` : "";
  const groundedProductEvidence = [
    target.name,
    target.description,
    target.tags?.join(" "),
    catalogClaims,
    provenanceEvidence,
  ].filter(Boolean).join("\n");
  const forbiddenProductNames = getForbiddenSiblingProducts(
    {
      id: target.id,
      title: target.name,
      description: target.description,
      tags: target.tags,
    },
    catalog.map((product) => ({ id: product.id, title: product.name })),
  ).map((product) => product.title);

  const factualEvidence: ProductFactualEvidence = {
    title: target.name,
    description: target.description || "",
    tags: target.tags,
    product_type: target.product_type,
    catalog_claims: [catalogClaims, provenanceEvidence].filter(Boolean).join("; "),
  };

  return { groundedProductEvidence, forbiddenProductNames, factualEvidence };
}
