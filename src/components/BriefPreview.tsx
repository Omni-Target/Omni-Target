"use client";

import { Check, Sparkles, Target, Zap } from "lucide-react";
import { useEffect, useState } from "react";

export function BriefPreview() {
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setActiveStep((prev) => (prev + 1) % 4);
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  const data = [
    { label: "Target Audience", value: "Fashion Enthusiasts (25-44)", icon: Target },
    { label: "Hero Product", value: "Vintage Linen Shirt", icon: Sparkles },
    { label: "Creative Angle", value: "Lifestyle / Aesthetic", icon: Zap },
    { label: "Budget Split", value: "70% Prospecting / 30% RT", icon: Check },
  ];

  return (
    <div className="glass-raised rounded-2xl overflow-hidden max-w-2xl w-full shadow-2xl animate-float">
      <div className="bg-surface-raised px-4 py-3 flex items-center gap-2 border-b border-border/40">
        <div className="flex gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-danger-500/40" />
          <div className="w-2.5 h-2.5 rounded-full bg-warning-500/40" />
          <div className="w-2.5 h-2.5 rounded-full bg-success-500/40" />
        </div>
        <div className="text-[10px] font-mono text-white/30 uppercase tracking-widest ml-4">
          omnitarget-insight-engine-v1.0
        </div>
      </div>

      <div className="p-8 space-y-6">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h3 className="text-xl font-bold tracking-tight text-gradient">Campaign Brief</h3>
            <p className="text-sm text-white/40 font-mono">Status: Ready to Launch</p>
          </div>
          <div className="px-3 py-1 rounded-full bg-success-500/10 border border-success-500/20 text-success-400 text-[10px] font-bold uppercase tracking-wider">
            Optimized
          </div>
        </div>

        <div className="grid gap-4">
          {data.map((item, idx) => (
            <div 
              key={item.label}
              className={`flex items-center gap-4 p-4 rounded-xl border transition-all duration-500 ${
                activeStep === idx 
                  ? "bg-brand-500/10 border-brand-500/40 translate-x-2" 
                  : "bg-white/5 border-transparent opacity-60"
              }`}
            >
              <div className={`p-2 rounded-lg ${activeStep === idx ? "bg-brand-500/20 text-brand-400" : "bg-white/5 text-white/30"}`}>
                <item.icon className="w-5 h-5" />
              </div>
              <div>
                <div className="text-[10px] font-mono text-white/40 uppercase tracking-tight">{item.label}</div>
                <div className="text-sm font-medium">{item.value}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 pt-6 border-t border-border/20 flex items-center justify-between">
          <div className="flex -space-x-2">
            {[1,2,3].map(i => (
              <div key={i} className="w-6 h-6 rounded-full border border-surface bg-brand-900/40" />
            ))}
            <div className="w-6 h-6 rounded-full border border-surface bg-surface-raised flex items-center justify-center text-[8px] text-white/40 font-bold">
              +12
            </div>
          </div>
          <div className="text-[10px] text-white/30 font-medium italic">
            Based on 2,400+ recent Shopify orders
          </div>
        </div>
      </div>
    </div>
  );
}
