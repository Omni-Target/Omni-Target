import type { EconomicsPolicy } from "../policy";
import { POLICY_V2 } from "./policy-v2";

/** Test fixture: economics policy version 3 as migration 0057 writes it (a draft; checked against the migration). */
export const POLICY_V3: EconomicsPolicy = {
  version: 3,
  approval: "pending",
  settings: { ...POLICY_V2.settings, refund_maturity_min_days: 60, scale_confidence: 0.975, pause_confidence: 0.95, require_spending_limits: true },
};
