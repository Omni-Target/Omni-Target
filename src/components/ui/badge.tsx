import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md font-medium leading-none transition-colors",
  {
    variants: {
      variant: {
        neutral: "bg-surface-muted text-muted-foreground",
        brand: "bg-brand-50 text-brand-700",
        success: "bg-success-50 text-success-700",
        warning: "bg-warning-50 text-warning-700",
        danger: "bg-danger-50 text-danger-700",
        info: "bg-info-50 text-info-600",
        outline: "border border-border text-muted-foreground",
        ink: "bg-ink text-ink-foreground",
        solid: "bg-brand-600 text-white",
      },
      size: {
        sm: "px-2 py-0.5 text-[0.6875rem]",
        md: "px-2.5 py-1 text-xs",
        lg: "px-3 py-1.5 text-[0.8125rem]",
      },
    },
    defaultVariants: { variant: "neutral", size: "md" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

export function Badge({
  className,
  variant,
  size,
  dot,
  children,
  ...props
}: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant, size }), className)} {...props}>
      {dot && (
        <span className="size-1.5 rounded-full bg-current opacity-70" aria-hidden />
      )}
      {children}
    </span>
  );
}

export { badgeVariants };
