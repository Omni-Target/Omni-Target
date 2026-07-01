/** All per-campaign input data collected/derived before generation. */
export interface CampaignFormState {
  brandName: string;
  productName: string;
  description: string;
  productPrice: string;
  productVariants: string;
  goal: string;
  tone: string;
  isNewLaunch: boolean;
  autoFilledFromStore: boolean;
}

export const initialCampaignForm: CampaignFormState = {
  brandName: "",
  productName: "",
  description: "",
  productPrice: "",
  productVariants: "",
  goal: "Drive Website Sales",
  tone: "Let AI decide (recommended)",
  isNewLaunch: false,
  autoFilledFromStore: false,
};

export type CampaignFormAction =
  | { type: "merge"; values: Partial<CampaignFormState> }
  | { type: "reset" };

/**
 * Single source of truth for the campaign form. `reset` returns the canonical
 * {@link initialCampaignForm}, so any field added to {@link CampaignFormState}
 * (and its initial value) is cleared on reset automatically — there is no second
 * list of fields that can fall out of sync. The single `merge` action keeps the
 * reducer fully type-safe (the typed setters in `useCampaignForm` build
 * correctly-typed partials).
 */
export function campaignFormReducer(
  state: CampaignFormState,
  action: CampaignFormAction,
): CampaignFormState {
  switch (action.type) {
    case "merge":
      return { ...state, ...action.values };
    case "reset":
      return initialCampaignForm;
    default:
      return state;
  }
}
