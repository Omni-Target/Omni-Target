import * as React from "react";
import { cn } from "@/lib/utils";

export interface LogoProps {
  className?: string;
  /** Pixel size of the square mark. */
  size?: number;
  /** "badge" = gradient rounded square; "plain" = monochrome glyph. */
  variant?: "badge" | "plain";
}

/** Omni Target mark — an aperture/target motif. */
export function Logo({ className, size = 32, variant = "badge" }: LogoProps) {
  const id = React.useId();
  if (variant === "plain") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        className={className}
        aria-hidden
      >
        <circle cx="16" cy="16" r="12.5" stroke="currentColor" strokeWidth="2.4" strokeOpacity="0.35" />
        <path
          d="M16 3.5a12.5 12.5 0 0 1 12.5 12.5"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <circle cx="16" cy="16" r="6" stroke="currentColor" strokeWidth="2.4" />
        <circle cx="16" cy="16" r="2.4" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={cn("shrink-0", className)}
      aria-hidden
    >
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#26262e" />
          <stop offset="55%" stopColor="#09090f" />
          <stop offset="100%" stopColor="#000000" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8.5" fill={`url(#${id}-bg)`} />
      <circle cx="16" cy="16" r="9" stroke="white" strokeWidth="2" strokeOpacity="0.45" />
      <path
        d="M16 7a9 9 0 0 1 9 9"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="4" stroke="white" strokeWidth="2" />
      <circle cx="16" cy="16" r="1.7" fill="white" />
    </svg>
  );
}

export interface WordmarkProps {
  className?: string;
  size?: number;
  textClassName?: string;
}

export function Wordmark({ className, size = 30, textClassName }: WordmarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <Logo size={size} />
      <span
        className={cn(
          "text-[1.0625rem] font-semibold tracking-[-0.02em] text-foreground",
          textClassName,
        )}
      >
        Omni Target
      </span>
    </span>
  );
}
