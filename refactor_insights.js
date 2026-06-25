const fs = require('fs');
let code = fs.readFileSync('src/lib/insights-engine.ts', 'utf8');

// 1. Update TargetingProfile interface
code = code.replace(
`  timing: TimingOutput;
}`,
`  timing: TimingOutput;
  optimization_event: {
    event: string;
    reasoning: string;
    target_weekly: number;
    upgrade_milestone: string;
  };
}`);

// 2. Update generateTargetingProfile signature
code = code.replace(
`async function generateTargetingProfile(
  storeData: StoreData
): Promise<TargetingProfile> {`,
`async function generateTargetingProfile(
  storeData: StoreData,
  adSets: number,
  dailyBudget: number
): Promise<TargetingProfile> {`);

// 3. Update the prompt to include the new instructions and context
const oldPromptEnd = `- Populate "peak_days" with the primary peak day(s) detected or recommended.
\`;`;

const newInstructions = `
Instructions for Optimization Event (Critical \u2014 Do Not Hardcode):
- The core question is: "Can Meta get enough optimization events per week to exit the learning phase given this store's budget and order velocity?"
- Use this logic internally to reason:
  - weeklyOrderVelocity = (monthly orders / 4)
  - estimatedWeeklyEventsAtBudget = weeklyOrderVelocity * (dailyBudget / avgOrderValue) * 7
- Walk down the event hierarchy (Purchase \u2192 InitiateCheckout \u2192 AddToCart \u2192 AddToWishlist \u2192 ViewContent) and select the highest event where estimatedWeeklyEventsAtBudget is likely to generate at least 10 events per week (10 is the realistic minimum for a small brand to see meaningful optimization signal).
- If the store has any purchase history at all, always try Purchase first before downgrading \u2014 a store with 8 monthly orders running a focused high budget can still generate purchase signal.
- Provide a plain English explanation of why this event makes sense to the merchant specifically stating what signal you expect and what to watch for.
- Also suggest a milestone to upgrade to the next level.

Campaign Context:
- Monthly Orders: \${storeData.orders.orders_last_30_days || 0}
- Recommended Ad Sets: \${adSets}
- Daily Budget per Ad Set: \${dailyBudget} \${storeCurrency}
\`;`;

code = code.replace(oldPromptEnd, oldPromptEnd.replace('`;', '') + newInstructions);

// 4. Update the tool schema
const oldSchemaEnd = `                  reasoning: { type: "string", description: "1-sentence explanation of why this launch timing works best." }
                },
                required: ["peak_days", "launch_recommendation", "reasoning"]
              }`;

const newSchemaSection = `,
              optimization_event: {
                type: "object",
                properties: {
                  event: { type: "string", description: "The recommended Meta Ads optimization event (e.g. Purchase, AddToCart, ViewContent)." },
                  reasoning: { type: "string", description: "Plain english explanation of why this event was chosen given budget and velocity." },
                  target_weekly: { type: "number", description: "The target number of events per week expected or required." },
                  upgrade_milestone: { type: "string", description: "A milestone suggestion for when to upgrade to a deeper funnel event." }
                },
                required: ["event", "reasoning", "target_weekly", "upgrade_milestone"]
              }`;

code = code.replace(oldSchemaEnd, oldSchemaEnd + newSchemaSection);

// Update required array for the tool schema
code = code.replace(
`required: ["locations", "demographics", "audiences", "timing"]`,
`required: ["locations", "demographics", "audiences", "timing", "optimization_event"]`
);

// 5. Update the fallback logic in generateTargetingProfile
const oldFallback = `    timing: {
      peak_days: storeData.orders.peak_days || [],
      launch_recommendation: "Launch on your highest traffic day to capture immediate momentum.",
      reasoning: "Launching before peak traffic hours ensures Meta has maximum budget available during highest intent periods."
    }
  };
}`;

const newFallback = `    timing: {
      peak_days: storeData.orders.peak_days || [],
      launch_recommendation: "Launch on your highest traffic day to capture immediate momentum.",
      reasoning: "Launching before peak traffic hours ensures Meta has maximum budget available during highest intent periods."
    },
    optimization_event: {
      event: "Add to Cart",
      reasoning: "A safe fallback event while the AI evaluates your full data.",
      target_weekly: 10,
      upgrade_milestone: "Switch to Purchase optimization once you get 10+ orders."
    }
  };
}`;

code = code.replace(oldFallback, newFallback);

// 6. Move budget and adSets calculations BEFORE generateTargetingProfile
// Find the index of: // Run unified AI single-pass call
const aiCallIndex = code.indexOf('  // Run unified AI single-pass call');

// Find the index of: // ── Dynamic Ad Sets: based on data maturity, not hardcoded ──
const adSetsIndex = code.indexOf('  // ── Dynamic Ad Sets: based on data maturity, not hardcoded ──');

// Find the index of: // Goal multipliers
const goalMultipliersIndex = code.indexOf('  // Goal multipliers (applied client-side, stored for reference)');

// We need to extract from adSetsIndex to goalMultipliersIndex, remove the optimization event hardcoding, and place it before aiCallIndex.
const extractedBlock = code.substring(adSetsIndex, goalMultipliersIndex);

// Process the extracted block to remove the hardcoded optimization event logic
const hardcodedOptStart = extractedBlock.indexOf('  // ── Optimization Event: based on orders-per-adset-per-week ──');
const hardcodedOptEnd = extractedBlock.indexOf('  // ── BUDGET CALCULATION (USD tiered revenue ratio with AOV liquidity guardrail) ──');

const newExtractedBlock = extractedBlock.substring(0, hardcodedOptStart) + extractedBlock.substring(hardcodedOptEnd);

// Replace the old block with nothing
code = code.substring(0, adSetsIndex) + code.substring(goalMultipliersIndex);

// Insert the new extracted block BEFORE the ai call
code = code.substring(0, aiCallIndex) + newExtractedBlock + '\n' + code.substring(aiCallIndex);

// 7. Update generateTargetingProfile call to include the parameters
code = code.replace(
`  // Run unified AI single-pass call
  const profile = await generateTargetingProfile(storeData);`,
`  // Run unified AI single-pass call
  const profile = await generateTargetingProfile(storeData, adSets, recommendedDaily);`
);

// 8. Update the budget optimization event assignment
const oldOptReturn = `      optimization_event: {
        event: optEvent,
        reasoning: optReasoning,
        target_weekly: optTarget,
        upgrade_milestone: optUpgradeMilestone,
      },`;
const newOptReturn = `      optimization_event: {
        event: profile.optimization_event.event,
        reasoning: profile.optimization_event.reasoning,
        target_weekly: profile.optimization_event.target_weekly,
        upgrade_milestone: profile.optimization_event.upgrade_milestone,
      },`;
      
code = code.replace(oldOptReturn, newOptReturn);

fs.writeFileSync('src/lib/insights-engine.ts', code);
console.log('Refactoring complete.');
