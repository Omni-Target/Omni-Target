const fs = require('fs');

// 1. Update insights-engine.ts
let engineCode = fs.readFileSync('src/lib/insights-engine.ts', 'utf8');

const defaultStrategiesOld = `        strategies: [
          {
            label: "Performance",
            daily: Math.round(20 * exchangeRate),
            total_daily: Math.round(20 * exchangeRate) * 2,
            description: "Default performance spend."
          },
          {
            label: "Balanced",
            daily: Math.round(15 * exchangeRate),
            total_daily: Math.round(15 * exchangeRate) * 2,
            description: "Default balanced spend."
          },
          {
            label: "Conservative",
            daily: Math.round(10 * exchangeRate),
            total_daily: Math.round(10 * exchangeRate) * 2,
            description: "Default conservative spend."
          }
        ]`;

const defaultStrategiesNew = `        strategies: [
          {
            label: "Dip Your Toe",
            daily: Math.round(15 * exchangeRate * 0.7),
            total_daily: Math.round(15 * exchangeRate * 0.7) * 2,
            description: "Low risk, slow learning. Good if you're testing for the first time."
          },
          {
            label: "Sweet Spot",
            daily: Math.round(15 * exchangeRate * 1.0),
            total_daily: Math.round(15 * exchangeRate * 1.0) * 2,
            description: "Our recommendation. Enough budget for Meta to learn without burning cash."
          },
          {
            label: "Full Send",
            daily: Math.round(15 * exchangeRate * 1.4),
            total_daily: Math.round(15 * exchangeRate * 1.4) * 2,
            description: "Faster results but higher daily spend. Best when you already know your creative works."
          }
        ]`;

engineCode = engineCode.replace(defaultStrategiesOld, defaultStrategiesNew);

const calculatedStrategiesOld = `  // ── Strategies ──
  const strategies = [
    {
      label: "Performance",
      daily: Math.round(finalDailyPerAdSetUSD * 1.3 * exchangeRate),
      total_daily: Math.round(finalDailyPerAdSetUSD * 1.3 * exchangeRate) * adSets,
      description: "Aggressive test spend to maximize data volume. Recommended if you want faster optimization."
    },
    {
      label: "Balanced",
      daily: recommendedDaily,
      total_daily: recommendedDaily * adSets,
      description: "Optimal test spend designed for sustainable pixel learning and early validation."
    },
    {
      label: "Conservative",
      daily: Math.round(Math.max(finalDailyPerAdSetUSD * 0.7, aovUSD * 0.5) * exchangeRate),
      total_daily: Math.round(Math.max(finalDailyPerAdSetUSD * 0.7, aovUSD * 0.5) * exchangeRate) * adSets,
      description: "Slower optimization but preserves cash flow. Best for new accounts with limited historical data."
    }
  ];`;

const calculatedStrategiesNew = `  // ── Strategies ──
  const strategies = [
    {
      label: "Dip Your Toe",
      daily: Math.round(finalDailyPerAdSetUSD * 0.7 * exchangeRate),
      total_daily: Math.round(finalDailyPerAdSetUSD * 0.7 * exchangeRate) * adSets,
      description: "Low risk, slow learning. Good if you're testing for the first time."
    },
    {
      label: "Sweet Spot",
      daily: recommendedDaily,
      total_daily: recommendedDaily * adSets,
      description: "Our recommendation. Enough budget for Meta to learn without burning cash."
    },
    {
      label: "Full Send",
      daily: Math.round(finalDailyPerAdSetUSD * 1.4 * exchangeRate),
      total_daily: Math.round(finalDailyPerAdSetUSD * 1.4 * exchangeRate) * adSets,
      description: "Faster results but higher daily spend. Best when you already know your creative works."
    }
  ];`;

engineCode = engineCode.replace(calculatedStrategiesOld, calculatedStrategiesNew);

fs.writeFileSync('src/lib/insights-engine.ts', engineCode);
console.log('Updated insights-engine.ts');

// 2. Update campaigns/page.tsx
let pageCode = fs.readFileSync('src/app/campaigns/page.tsx', 'utf8');

const strategyStateOld = `const [selectedStrategyIndex, setSelectedStrategyIndex] = useState(1); // 0=Performance, 1=Balanced, 2=Conservative`;
const strategyStateNew = `const [selectedStrategyIndex, setSelectedStrategyIndex] = useState(1); // 0=Dip Your Toe, 1=Sweet Spot, 2=Full Send`;
pageCode = pageCode.replace(strategyStateOld, strategyStateNew);

const uiMappingOld = `                      {strategies.map((s: any, idx: number) => (
                        <button
                          key={s.label}
                          onClick={() => setSelectedStrategyIndex(idx)}
                          className={\`flex flex-col items-center justify-center p-3 rounded-xl border transition-all duration-300 \${
                            selectedStrategyIndex === idx 
                              ? "bg-brand-500/10 border-brand-500/40 text-white" 
                              : "bg-white/[0.02] border-white/5 text-white/40 hover:bg-white/[0.05]"
                          }\`}
                        >
                          <span className="text-[10px] font-bold uppercase tracking-tighter text-center">{s.label.split(" ")[0]}</span>
                          <span className="text-xs font-bold mt-1">{formatCurrency(s.total_daily, curr, aiInsights.budget.currency_symbol)}</span>
                        </button>
                      ))}`;

const uiMappingNew = `                      {strategies.map((s: any, idx: number) => (
                        <button
                          key={s.label}
                          onClick={() => setSelectedStrategyIndex(idx)}
                          className={\`flex flex-col items-center justify-center p-3 rounded-xl border transition-all duration-300 relative \${
                            selectedStrategyIndex === idx 
                              ? "bg-brand-500/10 border-brand-500/40 text-white" 
                              : "bg-white/[0.02] border-white/5 text-white/40 hover:bg-white/[0.05]"
                          }\`}
                        >
                          {s.label === "Sweet Spot" && (
                            <div className="absolute -top-2 bg-brand-500 text-black text-[8px] font-black uppercase px-2 py-0.5 rounded-full shadow-lg border border-white/20 whitespace-nowrap z-10">RECOMMENDED</div>
                          )}
                          <span className="text-[10px] font-bold uppercase tracking-tighter text-center">{s.label}</span>
                          <span className="text-xs font-bold mt-1">{formatCurrency(s.total_daily, curr, aiInsights.budget.currency_symbol)}</span>
                        </button>
                      ))}`;

pageCode = pageCode.replace(uiMappingOld, uiMappingNew);
fs.writeFileSync('src/app/campaigns/page.tsx', pageCode);
console.log('Updated campaigns/page.tsx');
