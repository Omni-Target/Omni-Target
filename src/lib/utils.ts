import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names with clsx semantics and resolve Tailwind conflicts
 * (later utilities win). Same call signature as before — accepts strings,
 * conditional objects, arrays, and falsy values.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a number as compact currency using the store's symbol. */
export function formatCurrency(
  value: number,
  symbol = "$",
  options: { compact?: boolean } = {},
): string {
  if (!Number.isFinite(value)) return `${symbol}0`;
  const { compact = false } = options;
  if (compact && Math.abs(value) >= 1000) {
    const formatted = new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
    return `${symbol}${formatted}`;
  }
  return `${symbol}${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(Math.round(value))}`;
}

/** Clamp a number between min and max. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
