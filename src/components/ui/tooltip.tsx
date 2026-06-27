"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";

type Side = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  content: React.ReactNode;
  side?: Side;
  delay?: number;
  className?: string;
  children: React.ReactNode;
}

const sideClasses: Record<Side, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
  left: "right-full top-1/2 -translate-y-1/2 mr-2",
  right: "left-full top-1/2 -translate-y-1/2 ml-2",
};

export function Tooltip({
  content,
  side = "top",
  delay = 120,
  className,
  children,
}: TooltipProps) {
  const [open, setOpen] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      <AnimatePresence>
        {open && content && (
          <motion.span
            role="tooltip"
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.94 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "pointer-events-none absolute z-50 w-max max-w-xs rounded-lg bg-ink px-2.5 py-1.5 text-xs font-medium text-ink-foreground shadow-lg",
              sideClasses[side],
              className,
            )}
          >
            {content}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
