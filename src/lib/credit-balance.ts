/** Match the balance displayed by the credit gate on schemas with a legacy credits column. */
export function availableCredits(
  integration: { credits?: number | null; credits_balance?: number | null } | null,
  hasLegacyCreditsColumn: boolean,
): number {
  return (hasLegacyCreditsColumn ? integration?.credits : integration?.credits_balance)
    ?? integration?.credits_balance
    ?? 0;
}
