import * as React from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";

export interface LogoProps {
  className?: string;
  /** Pixel size of the square mark. */
  size?: number;
}

/**
 * Official Omni Target mark — renders the brand asset from
 * `public/omni_target_logo.png` as a rounded badge. Single source of truth for
 * in-app branding; the PDF brief template and emails embed the same asset.
 */
export function Logo({ className, size = 32 }: LogoProps) {
  return (
    <Image
      src="/omni_target_logo.png"
      alt=""
      aria-hidden
      width={size}
      height={size}
      quality={95}
      className={cn("shrink-0 select-none ring-1 ring-white/10", className)}
      // The source art is full-bleed; round it to the badge radius the UI used
      // before (rx 8.5 on a 32px tile).
      style={{ borderRadius: Math.round(size * 0.27) }}
    />
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
