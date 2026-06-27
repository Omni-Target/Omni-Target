"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";

interface MenuContextValue {
  close: () => void;
}
const MenuContext = React.createContext<MenuContextValue>({ close: () => {} });

export interface DropdownMenuProps {
  trigger: React.ReactNode;
  align?: "start" | "end";
  side?: "top" | "bottom";
  className?: string;
  children: React.ReactNode;
}

export function DropdownMenu({
  trigger,
  align = "end",
  side = "bottom",
  className,
  children,
}: DropdownMenuProps) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex"
      >
        {trigger}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.96, y: side === "bottom" ? -6 : 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: side === "bottom" ? -4 : 4 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "absolute z-50 min-w-[12rem] overflow-hidden rounded-xl border border-border-subtle bg-surface p-1.5 shadow-lg",
              side === "bottom" ? "top-full mt-2" : "bottom-full mb-2",
              align === "end" ? "right-0" : "left-0",
              className,
            )}
          >
            <MenuContext.Provider value={{ close: () => setOpen(false) }}>
              {children}
            </MenuContext.Provider>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export interface DropdownMenuItemProps
  extends React.HTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode;
  destructive?: boolean;
  onSelect?: () => void;
}

export function DropdownMenuItem({
  icon,
  destructive,
  onSelect,
  className,
  children,
  ...props
}: DropdownMenuItemProps) {
  const { close } = React.useContext(MenuContext);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onSelect?.();
        close();
      }}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors outline-none [&_svg]:size-4 [&_svg]:shrink-0",
        destructive
          ? "text-danger-600 hover:bg-danger-50"
          : "text-muted-foreground hover:bg-surface-muted hover:text-foreground",
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}

export function DropdownMenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 py-1.5 text-xs font-medium uppercase tracking-wide text-faint-foreground">
      {children}
    </div>
  );
}

export function DropdownMenuSeparator() {
  return <div className="my-1.5 h-px bg-border-subtle" />;
}
