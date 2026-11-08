/**
 * Charge-safety guard for brief generation (Phase S0.6 — AI-03).
 *
 * The insights engine degrades to generic defaults when the targeting or
 * creative-hooks AI step fails (e.g. default 25–44 audience, "fallback"
 * hooks); errors thrown inside its hooks recovery are swallowed there.
 * Committing such a brief charged the merchant a credit for output the
 * product did not actually generate. The generate route calls this guard
 * before committing (the commit is the only step that debits credits), so a
 * degraded generation fails with "no credit was charged" instead.
 */
import { CreativeHookGenerationError, TargetingGenerationError } from "./generation-errors";

export { CreativeHookGenerationError, TargetingGenerationError };

interface GenerationOutcome {
  generation_status?: "generated" | "fallback";
  creative_hooks_status?: "generated" | "fallback";
  creative_hooks?: unknown[];
}

/** Throws if the AI targeting or hooks step fell back to defaults. */
export function assertUsableRecommendations(recommendations: GenerationOutcome): void {
  if (recommendations.generation_status === "fallback") {
    throw new TargetingGenerationError();
  }
  if (
    recommendations.creative_hooks_status === "fallback" ||
    (recommendations.creative_hooks?.length ?? 0) < 3
  ) {
    throw new CreativeHookGenerationError();
  }
}
