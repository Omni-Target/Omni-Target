"use client";

import * as React from "react";

/**
 * Catches errors thrown in the root layout itself. It replaces the root layout
 * when active, so it must render its own <html>/<body> and cannot rely on the
 * app's global CSS — styles are inlined to stay self-contained. Next 16 passes
 * `unstable_retry` (not `reset`).
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  React.useEffect(() => {
    console.error("[global] root layout error", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1.25rem",
          padding: "1.5rem",
          textAlign: "center",
          background: "#fbfbfd",
          color: "#1a1a25",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>
          Something went wrong
        </h1>
        <p
          style={{
            maxWidth: "26rem",
            fontSize: "0.875rem",
            color: "#5b6472",
            margin: 0,
          }}
        >
          The application failed to load. Please try again — if the problem
          persists, contact support.
        </p>
        <button
          type="button"
          onClick={() => unstable_retry()}
          style={{
            cursor: "pointer",
            borderRadius: "0.5rem",
            border: "none",
            background: "#7c3aed",
            color: "#fff",
            padding: "0.625rem 1.25rem",
            fontSize: "0.875rem",
            fontWeight: 500,
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
