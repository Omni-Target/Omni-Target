import { useCallback, useReducer } from "react";
import {
  campaignFormReducer,
  initialCampaignForm,
  type CampaignFormState,
} from "@/lib/campaigns/form-reducer";

export type { CampaignFormState } from "@/lib/campaigns/form-reducer";

export interface UseCampaignFormResult extends CampaignFormState {
  setBrandName: (value: string) => void;
  setProductName: (value: string) => void;
  setDescription: (value: string) => void;
  setGoal: (value: string) => void;
  setTone: (value: string) => void;
  /** Merge a partial update — used to apply a store draft in one batch. */
  applyDraft: (values: Partial<CampaignFormState>) => void;
  /** Clear every field back to {@link initialCampaignForm}. */
  resetForm: () => void;
}

/**
 * Owns the campaign form state via a reducer whose `reset` returns the single
 * canonical initial state — so `resetForm()` can never forget a field. Field
 * values and the editable-field setters are returned under the same names the
 * page used when these were individual `useState` hooks, so call sites stay
 * unchanged. All returned functions are stable (safe to list in effect deps).
 */
export function useCampaignForm(): UseCampaignFormResult {
  const [form, dispatch] = useReducer(campaignFormReducer, initialCampaignForm);

  const setBrandName = useCallback(
    (value: string) => dispatch({ type: "merge", values: { brandName: value } }),
    [],
  );
  const setProductName = useCallback(
    (value: string) =>
      dispatch({ type: "merge", values: { productName: value } }),
    [],
  );
  const setDescription = useCallback(
    (value: string) =>
      dispatch({ type: "merge", values: { description: value } }),
    [],
  );
  const setGoal = useCallback(
    (value: string) => dispatch({ type: "merge", values: { goal: value } }),
    [],
  );
  const setTone = useCallback(
    (value: string) => dispatch({ type: "merge", values: { tone: value } }),
    [],
  );
  const applyDraft = useCallback(
    (values: Partial<CampaignFormState>) =>
      dispatch({ type: "merge", values }),
    [],
  );
  const resetForm = useCallback(() => dispatch({ type: "reset" }), []);

  return {
    ...form,
    setBrandName,
    setProductName,
    setDescription,
    setGoal,
    setTone,
    applyDraft,
    resetForm,
  };
}
