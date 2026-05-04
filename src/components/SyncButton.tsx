"use client";

export function SyncButton() {
  return (
    <button
      onClick={() =>
        fetch("/api/store/data", { cache: "no-store" }).then(() =>
          window.location.reload()
        )
      }
      className="mt-4 text-xs text-brand-400 hover:text-brand-300 transition-colors"
    >
      Force sync now →
    </button>
  );
}
