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
) {
  // AI-02: only the title, description and catalog claims can support a claim.
  // Tags are merchant labels, and a store's country says nothing about where a
  // product was made, so neither counts as evidence.
  const groundedProductEvidence = [
    target.name,
    target.description,
    catalogClaims,
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
    catalog_claims: catalogClaims,
  };

  return { groundedProductEvidence, forbiddenProductNames, factualEvidence };
}
