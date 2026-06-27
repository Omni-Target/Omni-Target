import * as React from "react";
import { cn } from "@/lib/utils";
import { Label } from "./label";

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  optional?: boolean;
}

/** Form field wrapper: label + control + hint/error. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  optional,
  className,
  children,
  ...props
}: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)} {...props}>
      {label && (
        <div className="flex items-center justify-between">
          <Label htmlFor={htmlFor} optional={optional}>
            {label}
          </Label>
        </div>
      )}
      {children}
      {error ? (
        <p className="text-xs font-medium text-danger-600">{error}</p>
      ) : hint ? (
        <p className="text-xs text-subtle-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
