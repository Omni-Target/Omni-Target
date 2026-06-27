import * as React from "react";
import { cn } from "@/lib/utils";

export interface LabelProps
  extends React.LabelHTMLAttributes<HTMLLabelElement> {
  optional?: boolean;
}

export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, optional, children, ...props }, ref) => (
    <label
      ref={ref}
      className={cn(
        "flex items-center gap-1.5 text-sm font-medium text-foreground",
        className,
      )}
      {...props}
    >
      {children}
      {optional && (
        <span className="text-xs font-normal text-faint-foreground">
          Optional
        </span>
      )}
    </label>
  ),
);
Label.displayName = "Label";
