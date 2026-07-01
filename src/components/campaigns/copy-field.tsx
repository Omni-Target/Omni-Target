"use client";

import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

export function CopyField({
  label,
  value,
  fieldKey,
  copiedField,
  onCopy,
  emphasis = "default",
}: {
  label: string;
  value: string;
  fieldKey: string;
  copiedField: string | null;
  onCopy: (text: string, field: string) => void;
  emphasis?: "default" | "strong" | "muted";
}) {
  const copied = copiedField === fieldKey;
  return (
    <div className="w-full">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-faint-foreground">
          {label}
        </span>
        <button
          type="button"
          onClick={() => onCopy(value, fieldKey)}
          aria-label={copied ? `${label} copied` : `Copy ${label}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 transition-colors hover:text-brand-700"
        >
          {copied ? (
            <>
              <Check className="size-3.5" /> Copied
            </>
          ) : (
            <>
              <Copy className="size-3.5" /> Copy
            </>
          )}
        </button>
      </div>
      <div className="rounded-xl border border-border-subtle bg-surface-subtle p-3">
        <p
          className={cn(
            "whitespace-pre-wrap break-words text-sm leading-relaxed",
            emphasis === "strong"
              ? "font-medium text-foreground"
              : emphasis === "muted"
                ? "text-muted-foreground"
                : "text-foreground/90",
          )}
        >
          {value}
        </p>
      </div>
    </div>
  );
}
