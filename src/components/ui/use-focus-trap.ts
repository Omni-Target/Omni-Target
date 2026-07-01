import * as React from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Accessible modal focus management for dialogs/drawers:
 *  - moves focus into the container when it opens (first focusable, else the
 *    container itself — which must be `tabIndex={-1}`),
 *  - traps Tab / Shift+Tab within the container,
 *  - restores focus to the previously focused element on close.
 *
 * Implements the WAI-ARIA dialog pattern that the base components were missing.
 */
export function useFocusTrap(
  open: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
) {
  React.useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const getFocusable = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

    // Move focus into the dialog.
    const initial = getFocusable()[0] ?? container;
    initial.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = getFocusable();
      if (items.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Restore focus to the trigger so keyboard users keep their place.
      previouslyFocused?.focus?.();
    };
  }, [open, containerRef]);
}
