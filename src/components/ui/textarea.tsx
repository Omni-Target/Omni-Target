import * as React from "react";
import { cn } from "@/lib/utils";

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, ...props }, ref) => (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "min-h-[120px] w-full resize-y rounded-lg border bg-surface px-3.5 py-3 text-sm text-foreground shadow-xs transition-[border-color,box-shadow] duration-150 placeholder:text-faint-foreground",
        "focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-500/14",
        "disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:opacity-60",
        invalid
          ? "border-danger-400 focus-visible:border-danger-500 focus-visible:ring-danger-500/14"
          : "border-border",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
