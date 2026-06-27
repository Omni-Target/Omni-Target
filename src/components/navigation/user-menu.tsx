"use client";

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

  const name =
    user?.fullName || user?.primaryEmailAddress?.emailAddress?.split("@")[0] || "Account";
  const email = user?.primaryEmailAddress?.emailAddress ?? "";
  const image = user?.imageUrl;

  const trigger =
    variant === "full" ? (
      <span className="flex w-full items-center gap-2.5 rounded-xl border border-border-subtle bg-surface p-2 text-left transition-colors hover:bg-surface-subtle">
        <Avatar src={image} name={name} size="md" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {name}
          </span>
          <span className="block truncate text-xs text-subtle-foreground">
            {email}
          </span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-faint-foreground" />
      </span>
    ) : (
      <span className="rounded-full ring-2 ring-transparent transition-shadow hover:ring-border">
        <Avatar src={image} name={name} size="md" />
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
        <Avatar src={image} name={name} size="md" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{name}</p>
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
