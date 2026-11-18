import { defineConfig } from "@trigger.dev/sdk";

/**
 * Trigger.dev runs Omnitarget's durable background work (Phase 2): imports,
 * incremental sync, summary maintenance and compliance workflows. Tasks live
 * in src/trigger and stay thin; each calls a module service.
 *
 * The CLI uses the `omnitarget` login profile (see package.json `dev:trigger`),
 * never the machine's default profile.
 */
export default defineConfig({
  project: "proj_owlfjcsbkqwtsyyykwqd",
  dirs: ["./src/trigger"],
  // Seconds of compute per run. Long imports checkpoint and continue in a new run.
  maxDuration: 3600,
  retries: {
    enabledInDev: true,
    default: { maxAttempts: 3, minTimeoutInMs: 1_000, maxTimeoutInMs: 10_000, factor: 2, randomize: true },
  },
  build: {
    // Workers run the app's server modules, which import "server-only"; under
    // the react-server condition that marker resolves to an empty module.
    conditions: ["react-server"],
  },
});
