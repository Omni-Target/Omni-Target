"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Info,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useMounted } from "./use-mounted";

type ToastVariant = "default" | "success" | "warning" | "danger" | "info";

interface ToastItem {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant: ToastVariant;
  duration: number;
}

interface ToastOptions {
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  duration?: number;
}

interface ToastContextValue {
  toast: (opts: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

const iconMap: Record<ToastVariant, React.ElementType> = {
  default: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  info: Info,
};

const accentMap: Record<ToastVariant, string> = {
  default: "text-brand-600",
  success: "text-success-600",
  warning: "text-warning-600",
  danger: "text-danger-600",
  info: "text-info-600",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const mounted = useMounted();

  const dismiss = React.useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const toast = React.useCallback(
    (opts: ToastOptions) => {
      const id = Math.random().toString(36).slice(2);
      const item: ToastItem = {
        id,
        title: opts.title,
        description: opts.description,
        variant: opts.variant ?? "default",
        duration: opts.duration ?? 4500,
      };
      setToasts((t) => [...t, item]);
      if (item.duration > 0) {
        setTimeout(() => dismiss(id), item.duration);
      }
      return id;
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      {children}
      {mounted &&
        createPortal(
          <div
            role="region"
            aria-label="Notifications"
            className="pointer-events-none fixed bottom-4 right-4 z-200 flex w-full max-w-sm flex-col gap-2.5"
          >
            <AnimatePresence initial={false}>
              {toasts.map((t) => {
                const Icon = iconMap[t.variant];
                const assertive = t.variant === "danger" || t.variant === "warning";
                return (
                  <motion.div
                    key={t.id}
                    layout
                    role={assertive ? "alert" : "status"}
                    aria-live={assertive ? "assertive" : "polite"}
                    initial={{ opacity: 0, y: 16, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, x: 24, scale: 0.96 }}
                    transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
                    className="pointer-events-auto flex items-start gap-3 rounded-xl border border-border bg-surface-overlay p-4 shadow-lg"
                  >
                    <Icon className={cn("mt-0.5 size-5 shrink-0", accentMap[t.variant])} />
                    <div className="min-w-0 flex-1">
                      {t.title && (
                        <p className="text-sm font-semibold text-foreground">
                          {t.title}
                        </p>
                      )}
                      {t.description && (
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          {t.description}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => dismiss(t.id)}
                      aria-label="Dismiss"
                      className="grid size-6 shrink-0 place-items-center rounded-md text-faint-foreground transition-colors hover:bg-surface-muted hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}
