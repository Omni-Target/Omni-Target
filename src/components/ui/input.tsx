import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  startIcon?: React.ReactNode;
  endIcon?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, startIcon, endIcon, ...props }, ref) => {
    const field = (
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          "h-11 w-full rounded-lg border bg-surface px-3.5 text-sm text-foreground shadow-xs transition-[border-color,box-shadow] duration-150 placeholder:text-faint-foreground",
          "focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-500/14",
          "disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:opacity-60",
          invalid
            ? "border-danger-400 focus-visible:border-danger-500 focus-visible:ring-danger-500/14"
            : "border-border",
          startIcon ? "pl-10" : "",
          endIcon ? "pr-10" : "",
          className,
        )}
        {...props}
      />
    );

    if (!startIcon && !endIcon) return field;

    return (
      <div className="relative w-full">
        {startIcon && (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle-foreground [&_svg]:size-4">
            {startIcon}
          </span>
        )}
        {field}
        {endIcon && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-subtle-foreground [&_svg]:size-4">
            {endIcon}
          </span>
        )}
      </div>
    );
  },
);
Input.displayName = "Input";
