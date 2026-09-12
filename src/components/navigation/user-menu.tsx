"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useUser, useClerk } from "@clerk/nextjs";
import { Settings, LogOut, CreditCard, ChevronsUpDown } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/menu";

export function UserMenu({ variant = "compact" }: { variant?: "compact" | "full" }) {
  const { user } = useUser();
  const { signOut } = useClerk();

  const metadata = (user?.publicMetadata || {}) as {
    storeName?: string;
    storeLogoUrl?: string;
    shopifyStoreUrl?: string;
  };

  const storeName = metadata.storeName;
  const storeLogoUrl = metadata.storeLogoUrl;

  // Check and reject any favicon URLs (stale or cached)
  const isFavicon = (url?: string | null) =>
    !url ||
    url.includes("google.com/s2/favicons") ||
    url.includes("favicon") ||
    url.includes(".ico");

  // Cleanse any stale favicon URL stored in Clerk metadata in the background
  useEffect(() => {
    if (storeLogoUrl && isFavicon(storeLogoUrl)) {
      fetch("/api/user/update-metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeLogoUrl: null }),
      }).catch(() => {});
    }
  }, [storeLogoUrl]);

  const displayName =
    storeName ||
    user?.fullName ||
    user?.primaryEmailAddress?.emailAddress?.split("@")[0] ||
    "Account";
  const email = user?.primaryEmailAddress?.emailAddress ?? "";

  // Only use official brand logo from Shopify.
  // If not available, use a colorful geometric default random avatar seeded by store name.
  const officialLogo = isFavicon(storeLogoUrl) ? null : storeLogoUrl;
  const defaultRandomAvatar = `https://api.dicebear.com/7.x/shapes/svg?seed=${encodeURIComponent(
    storeName || displayName || user?.id || "omni"
  )}`;

  const image = officialLogo || defaultRandomAvatar;

  const trigger =
    variant === "full" ? (
      <span className="flex w-full items-center gap-2.5 rounded-xl border border-border-subtle bg-surface p-2 text-left transition-colors hover:bg-surface-subtle">
        <Avatar src={image} name={displayName} size="md" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="block truncate text-xs text-subtle-foreground">
            {email}
          </span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-faint-foreground" />
      </span>
    ) : (
      <span className="rounded-full ring-2 ring-transparent transition-shadow hover:ring-border">
        <Avatar src={image} name={displayName} size="md" />
      </span>
    );

  return (
    <DropdownMenu
      trigger={trigger}
      side={variant === "full" ? "top" : "bottom"}
      align={variant === "full" ? "start" : "end"}
      className="w-60"
    >
      <div className="flex items-center gap-2.5 px-2.5 py-2">
        <Avatar src={image} name={displayName} size="md" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{displayName}</p>
          <p className="truncate text-xs text-subtle-foreground">{email}</p>
        </div>
      </div>
      <DropdownMenuSeparator />
      <Link href="/settings">
        <DropdownMenuItem icon={<Settings />}>Settings</DropdownMenuItem>
      </Link>
      <Link href="/pricing">
        <DropdownMenuItem icon={<CreditCard />}>Credits & billing</DropdownMenuItem>
      </Link>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        icon={<LogOut />}
        destructive
        onSelect={() => signOut({ redirectUrl: "/login" })}
      >
        Sign out
      </DropdownMenuItem>
    </DropdownMenu>
  );
}
