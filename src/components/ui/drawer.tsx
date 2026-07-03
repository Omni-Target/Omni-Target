"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMounted } from "./use-mounted";
import { useFocusTrap } from "./use-focus-trap";

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "right" | "left";
  title?: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
  className?: string;
  children?: React.ReactNode;
}

export function Drawer({
  open,
  onOpenChange,
  side = "right",
  title,
  description,
  footer,
  width = "max-w-md",
  className,
  children,
}: DrawerProps) {
  const mounted = useMounted();
  const contentRef = React.useRef<HTMLElement>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onOpenChange]);

  useFocusTrap(open, contentRef);

  if (!mounted) return null;
  const offscreen = side === "right" ? "100%" : "-100%";

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-100">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
            onClick={() => onOpenChange(false)}
          />
          <motion.aside
            ref={contentRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-describedby={description ? descriptionId : undefined}
            tabIndex={-1}
            initial={{ x: offscreen }}
            animate={{ x: 0 }}
            exit={{ x: offscreen }}
            transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "absolute inset-y-0 flex w-full flex-col bg-surface-overlay shadow-xl outline-none",
              side === "right" ? "right-0 border-l" : "left-0 border-r",
              "border-border-subtle",
              width,
              className,
            )}
          >
            <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-6 py-5">
              <div className="flex flex-col gap-1">
                {title && (
                  <h2
                    id={titleId}
                    className="text-base font-semibold tracking-[-0.01em] text-foreground"
                  >
                    {title}
                  </h2>
                )}
                {description && (
                  <p id={descriptionId} className="text-sm text-muted-foreground">
                    {description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="Close"
                className="grid size-8 shrink-0 place-items-center rounded-lg text-subtle-foreground transition-colors hover:bg-surface-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
            {footer && (
              <div className="flex items-center justify-end gap-3 border-t border-border-subtle bg-surface-subtle px-6 py-4">
                {footer}
              </div>
            )}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
