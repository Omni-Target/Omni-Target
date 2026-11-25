import type { EconomicsPolicy } from "../policy";
import { POLICY_V1 } from "./policy-v1";

/** Test fixture: economics policy version 2 as migration 0056 writes it (checked against the migration). Pending approval. */
export const POLICY_V2: EconomicsPolicy = {
  version: 2,
  approval: "pending",
  settings: { ...POLICY_V1.settings, estimate_downside_factor: 1.5, micro_pilot_min_conversions: 1, refund_maturity_min_days: 30,
    refund_maturity_max_days: 120, refund_lag_min_refunds: 20 },
};
