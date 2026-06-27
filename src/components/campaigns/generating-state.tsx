"use client";

import { motion } from "motion/react";
import { Sparkles } from "lucide-react";

export function GeneratingState() {
  return (
    <div className="flex min-h-[60vh] flex-1 flex-col items-center justify-center py-10">
      <div className="relative mb-8 grid size-24 place-items-center">
        <motion.span
          className="absolute inset-0 rounded-full border-2 border-brand-200"
          animate={{ rotate: 360 }}
          transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
        />
        <motion.span
          className="absolute inset-2 rounded-full border-2 border-brand-400/60"
          animate={{ rotate: -360 }}
          transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
        />
        <motion.div
          animate={{ scale: [1, 1.15, 1] }}
          transition={{ duration: 1.6, repeat: Infinity }}
          className="text-brand-600"
        >
          <Sparkles className="size-7" />
        </motion.div>
      </div>
      <h2 className="text-xl font-medium tracking-tight text-foreground">
        Writing your ad copy…
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Analysing your store data and crafting hook-driven copy.
      </p>
    </div>
  );
}
