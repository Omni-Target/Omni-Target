"use client";

import Link from "next/link";
import { Drawer } from "@/components/ui/drawer";
import { Wordmark } from "@/components/shared/logo";
import { UserMenu } from "./user-menu";
import { SidebarNav } from "./sidebar-nav";

export function MobileNav({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      side="left"
      width="max-w-[18rem]"
      title={
        <Link href="/dashboard" onClick={() => onOpenChange(false)}>
          <Wordmark size={26} />
        </Link>
      }
    >
      <div className="flex h-full flex-col">
        <SidebarNav onNavigate={() => onOpenChange(false)} showDescriptions />
        <div className="mt-auto pt-4">
          <UserMenu variant="full" />
        </div>
      </div>
    </Drawer>
  );
}
