import * as React from "react";
import { cn } from "@/lib/utils";

const widthMap = {
  narrow: "max-w-3xl",
  default: "max-w-5xl",
  wide: "max-w-[1440px]",
  full: "max-w-none",
} as const;

export interface PageContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  width?: keyof typeof widthMap;
}

export function PageContainer({
  width = "wide",
  className,
  children,
  ...props
}: PageContainerProps) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-5 py-7 sm:px-8 sm:py-9",
        widthMap[width],
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
