"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { PRIMARY_NAV } from "./nav-config";

export function SidebarNav({
  onNavigate,
  showDescriptions = false,
}: {
  onNavigate?: () => void;
  showDescriptions?: boolean;
}) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      {PRIMARY_NAV.map((item) => {
        const active =
          pathname === item.href || pathname?.startsWith(item.href + "/");
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
              active
                ? "bg-brand-50 text-brand-700"
                : "text-muted-foreground hover:bg-surface-subtle hover:text-foreground",
            )}
          >
            {active && (
              <span className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-brand-600" />
            )}
            <Icon
              className={cn(
                "size-[1.15rem] shrink-0 transition-colors",
                active ? "text-brand-600" : "text-subtle-foreground group-hover:text-foreground",
              )}
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{item.label}</span>
              {showDescriptions && item.description && (
                <span className="truncate text-xs font-normal text-faint-foreground">
                  {item.description}
                </span>
              )}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
