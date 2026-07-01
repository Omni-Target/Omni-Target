"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMounted } from "./use-mounted";
import { useFocusTrap } from "./use-focus-trap";

const sizeMap = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
  "2xl": "max-w-3xl",
} as const;

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  size?: keyof typeof sizeMap;
  footer?: React.ReactNode;
  hideClose?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  size = "md",
  footer,
  hideClose,
  className,
  children,
}: DialogProps) {
  const mounted = useMounted();
  const contentRef = React.useRef<HTMLDivElement>(null);
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

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-100 flex items-center justify-center p-4 sm:p-6">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
            onClick={() => onOpenChange(false)}
          />
          <motion.div
            ref={contentRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-describedby={description ? descriptionId : undefined}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "outline-none",
              "relative z-10 w-full overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-xl",
              sizeMap[size],
              className,
            )}
          >
            {!hideClose && (
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="Close"
                className="absolute right-4 top-4 z-10 grid size-8 place-items-center rounded-lg text-subtle-foreground transition-colors hover:bg-surface-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
            {(title || description) && (
              <div className="flex flex-col gap-1.5 px-6 pb-2 pt-6 pr-12">
                {title && (
                  <h2
                    id={titleId}
                    className="text-lg font-semibold tracking-[-0.01em] text-foreground"
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
            )}
            {children && <div className="px-6 py-4">{children}</div>}
            {footer && (
              <div className="flex items-center justify-end gap-3 border-t border-border-subtle bg-surface-subtle px-6 py-4">
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
