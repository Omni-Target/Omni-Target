"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useUser, useClerk } from "@clerk/nextjs";
import { Settings, LogOut, CreditCard, ChevronsUpDown } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { normalizeStoreLogoUrl } from "@/lib/store-logo-url";
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
  const officialLogo = normalizeStoreLogoUrl(metadata.storeLogoUrl);

  // Refresh branding once for stores connected before logo discovery was fixed.
  useEffect(() => {
    if (!user?.id || officialLogo) return;
    const key = `store-logo-sync-v2:${user.id}`;
    if (sessionStorage.getItem(key)) return;

    fetch("/api/user/sync-store-logo", { method: "POST" })
      .then((response) => {
        if (!response.ok) throw new Error("Logo sync failed");
        return response.json() as Promise<{ logoUrl: string | null }>;
      })
      .then(({ logoUrl }) => {
        sessionStorage.setItem(key, "done");
        if (logoUrl) return user.reload();
      })
      .catch(() => {
        // Allow retry on error
      });
  }, [user, officialLogo]);

  const displayName =
    storeName ||
    user?.fullName ||
    user?.primaryEmailAddress?.emailAddress?.split("@")[0] ||
    "Account";
  const email = user?.primaryEmailAddress?.emailAddress ?? "";

  const image = officialLogo || (user?.hasImage ? user?.imageUrl : null);

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
