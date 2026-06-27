import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Minimal Slot: merges props/className onto a single child element. */
const Slot = React.forwardRef<
  HTMLElement,
  React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }
>(({ children, className, ...props }, ref) => {
  if (!React.isValidElement(children)) return null;
  const child = children as React.ReactElement<Record<string, unknown>>;
  return React.cloneElement(child, {
    ...props,
    ...child.props,
    ref,
    className: cn(className, child.props.className as string | undefined),
  });
});
Slot.displayName = "Slot";

export const buttonVariants = cva(
  "relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-[background,box-shadow,transform,color,border-color] duration-200 ease-soft outline-none focus-visible:ring-2 focus-visible:ring-brand-500/45 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-55 active:translate-y-px select-none",
  {
    variants: {
      variant: {
        primary:
          "bg-brand-600 text-white shadow-sm hover:bg-brand-700 hover:shadow-brand",
        secondary:
          "bg-surface text-foreground border border-border shadow-xs hover:bg-surface-subtle hover:border-border-strong",
        outline:
          "border border-border text-foreground hover:bg-surface-subtle hover:border-border-strong",
        ghost:
          "text-muted-foreground hover:bg-surface-muted hover:text-foreground",
        subtle: "bg-brand-50 text-brand-700 hover:bg-brand-100",
        ink: "bg-ink text-ink-foreground shadow-sm hover:bg-ink-700",
        danger:
          "bg-danger-600 text-white shadow-sm hover:bg-danger-700",
        "danger-soft":
          "bg-danger-50 text-danger-700 hover:bg-danger-100",
        link: "text-brand-600 underline-offset-4 hover:underline px-0 h-auto",
      },
      size: {
        sm: "h-9 px-3.5 text-[0.8125rem]",
        md: "h-10 px-4 text-sm",
        lg: "h-11 px-5 text-[0.9375rem]",
        xl: "h-12 px-6 text-base",
        icon: "h-10 w-10 p-0",
        "icon-sm": "h-8 w-8 p-0",
        "icon-lg": "h-11 w-11 p-0",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  isLoading?: boolean;
  /** Render as the single child element (e.g. a Link) instead of a button. */
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, isLoading, asChild, disabled, children, ...props },
    ref,
  ) => {
    if (asChild) {
      return (
        <Slot
          ref={ref as React.Ref<HTMLElement>}
          className={cn(buttonVariants({ variant, size }), className)}
          {...props}
        >
          {children}
        </Slot>
      );
    }
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || isLoading}
        aria-busy={isLoading || undefined}
        {...props}
      >
        {isLoading && (
          <svg
            className="size-4 animate-spin-slow"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="12"
              cy="12"
              r="9"
              stroke="currentColor"
              strokeOpacity="0.25"
              strokeWidth="2.5"
            />
            <path
              d="M21 12a9 9 0 0 0-9-9"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </svg>
        )}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
