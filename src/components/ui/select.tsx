import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

/** Styled native select with a custom chevron. */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, invalid, children, ...props }, ref) => (
    <div className="relative w-full">
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          "h-11 w-full appearance-none rounded-lg border bg-surface pl-3.5 pr-10 text-sm text-foreground shadow-xs transition-[border-color,box-shadow] duration-150",
          "focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-500/14",
          "disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:opacity-60",
          invalid ? "border-danger-400" : "border-border",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-subtle-foreground"
        aria-hidden
      />
    </div>
  ),
);
Select.displayName = "Select";
