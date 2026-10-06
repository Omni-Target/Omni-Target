"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const sizeMap = {
  sm: "size-7 text-[0.6875rem]",
  md: "size-9 text-xs",
  lg: "size-11 text-sm",
  xl: "size-14 text-base",
} as const;

export interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  src?: string | null;
  name?: string;
  size?: keyof typeof sizeMap;
}

function initials(name?: string) {
  if (!name) return "";
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

export function Avatar({
  src,
  name,
  size = "md",
  className,
  ...props
}: AvatarProps) {
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const image = src && src !== failedSrc ? src : null;

  return (
    <div
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden rounded-full border border-border-subtle font-semibold",
        image ? "bg-white" : "bg-gradient-brand-vivid text-white",
        sizeMap[size],
        className,
      )}
      {...props}
    >
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image}
          alt={name ?? "Store logo"}
          className="size-full object-contain p-0.5"
          onError={() => setFailedSrc(image)}
        />
      ) : (
        <span aria-hidden>{initials(name) || "·"}</span>
      )}
    </div>
  );
}
