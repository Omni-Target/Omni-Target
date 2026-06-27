import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import {
  Info,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

const alertVariants = cva(
  "relative flex gap-3 rounded-xl border p-4 text-sm",
  {
    variants: {
      variant: {
        info: "border-info-100 bg-info-50 text-info-600",
        success: "border-success-100 bg-success-50 text-success-700",
        warning: "border-warning-100 bg-warning-50 text-warning-700",
        danger: "border-danger-100 bg-danger-50 text-danger-700",
        brand: "border-brand-100 bg-brand-50 text-brand-700",
        neutral: "border-border bg-surface-subtle text-muted-foreground",
      },
    },
    defaultVariants: { variant: "info" },
  },
);

const iconMap = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  brand: Sparkles,
  neutral: Info,
} as const;

export interface AlertProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">,
    VariantProps<typeof alertVariants> {
  title?: React.ReactNode;
  icon?: React.ReactNode | false;
}

export function Alert({
  className,
  variant = "info",
  title,
  icon,
  children,
  ...props
}: AlertProps) {
  const Icon = iconMap[variant ?? "info"];
  return (
    <div className={cn(alertVariants({ variant }), className)} role="alert" {...props}>
      {icon !== false && (
        <span className="mt-0.5 shrink-0">
          {icon ?? <Icon className="size-4.5" aria-hidden />}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold leading-snug">{title}</p>}
        {children && (
          <div className={cn("text-current/85", title && "mt-1")}>{children}</div>
        )}
      </div>
    </div>
  );
}
