import * as React from "react";
import { cn } from "@/lib/utils";

const sizeMap = {
  sm: "size-4",
  md: "size-5",
  lg: "size-7",
  xl: "size-10",
} as const;

export interface SpinnerProps extends React.SVGProps<SVGSVGElement> {
  size?: keyof typeof sizeMap;
  label?: string;
}

export function Spinner({
  size = "md",
  label = "Loading",
  className,
  ...props
}: SpinnerProps) {
  return (
    <svg
      role="status"
      aria-label={label}
      viewBox="0 0 24 24"
      fill="none"
      className={cn("animate-spin-slow text-brand-600", sizeMap[size], className)}
      {...props}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="2.5"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
