/**
 * Brief-generation failure types that mean "nothing was saved or charged".
 * Kept dependency-free so guards and tests can import them without loading
 * the insights engine (which initialises the database client on import).
 */
export class CreativeHookGenerationError extends Error {
  constructor() {
    super("Product-specific creative hooks could not be generated.");
    this.name = "CreativeHookGenerationError";
  }
}

export class TargetingGenerationError extends Error {
  constructor() {
    super("Audience targeting could not be generated.");
    this.name = "TargetingGenerationError";
  }
}
