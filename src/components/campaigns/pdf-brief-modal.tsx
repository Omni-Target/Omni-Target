"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, FileText, Loader2, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMounted } from "@/components/ui/use-mounted";
import { pdfFileName, type BriefPDFParams } from "@/lib/brief-pdf-types";

/**
 * Full-screen brief viewer, rendered as a modal (no route change). It shows the
 * exact same white-themed brief document that used to open on a standalone page
 * (server-built HTML from `buildBriefHTML`, fetched in "embed" mode so it has no
 * toolbar/auto-print), inside a full-viewport iframe. Controls live in the top
 * bar: Print (browser dialog → Save as PDF, the original mechanism), Download
 * PDF (a real file rendered server-side — no print dialog), Finalize campaign,
 * Close.
 */
export function PdfBriefModal({
  open,
  params,
  onFinalize,
  finalizing = false,
}: {
  open: boolean;
  params: BriefPDFParams | null;
  onFinalize: () => void;
  finalizing?: boolean;
}) {
  const mounted = useMounted();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [building, setBuilding] = useState(true);
  const [error, setError] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Fetch the exact brief document HTML (embed mode = no toolbar / auto-print).
  useEffect(() => {
    if (!open || !params) return;
    let cancelled = false;
    setBuilding(true);
    setError(false);
    setHtml(null);
    (async () => {
      try {
        const res = await fetch("/api/campaigns/pdf?embed=1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
        if (!res.ok) throw new Error(`Preview failed: ${res.status}`);
        const text = await res.text();
        if (!cancelled) setHtml(text);
      } catch (e) {
        console.error("Failed to load brief preview:", e);
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setBuilding(false);
      }
    })();

    const prevOverflow = document.body.style.overflow;
    const prevTitle = document.title;
    document.body.style.overflow = "hidden";
    if (params?.productName) {
      document.title = `${params.productName} — Omni Target Campaign Brief`;
    }
    return () => {
      cancelled = true;
      document.body.style.overflow = prevOverflow;
      document.title = prevTitle;
    };
  }, [open, params]);

  // Print the document exactly as before (browser dialog → Save as PDF).
  const handlePrint = () => {
    const prodName = params?.productName?.trim();
    const dynamicTitle = prodName
      ? `${prodName} — Omni Target Campaign Brief`
      : "Omni Target Campaign Brief";
    document.title = dynamicTitle;
    try {
      if (iframeRef.current?.contentDocument) {
        iframeRef.current.contentDocument.title = dynamicTitle;
      }
    } catch {
      /* ignore */
    }
    iframeRef.current?.contentWindow?.focus();
    iframeRef.current?.contentWindow?.print();
  };

  // Download a real .pdf of the exact same document (no print dialog). The
  // server renders it with the real browser engine, so it's a faithful, vector
  // reproduction of the preview. Falls back to the print dialog on failure.
  const handleDownload = useCallback(async () => {
    if (!params) return;
    setDownloading(true);
    try {
      const res = await fetch("/api/campaigns/pdf?format=pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = pdfFileName(params);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      console.error("Download failed, falling back to print:", e);
      iframeRef.current?.contentWindow?.focus();
      iframeRef.current?.contentWindow?.print();
    } finally {
      setDownloading(false);
    }
  }, [params]);

  if (!mounted || !open) return null;

  const busy = building || error;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-ink">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
            <FileText className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground sm:text-base">
              Your campaign brief
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              Review it, then print or download — finalize when you&apos;re done.
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handlePrint}
            disabled={busy}
          >
            <Printer className="size-4" />
            <span className="hidden sm:inline">Print</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleDownload}
            isLoading={downloading}
            disabled={busy}
          >
            {!downloading && <Download className="size-4" />}
            <span className="hidden sm:inline">Download PDF</span>
          </Button>
          <Button size="sm" onClick={onFinalize} isLoading={finalizing}>
            Finalize campaign
          </Button>
        </div>
      </div>

      {/* Full-viewport document preview */}
      <div className="relative flex-1 overflow-hidden">
        {building ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-ink-foreground/80">
            <Loader2 className="size-4 animate-spin" /> Building your brief…
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-sm text-ink-foreground/80">
            <p>Couldn&apos;t render the preview.</p>
            <p className="text-ink-foreground/60">
              You can still finalize the campaign to continue.
            </p>
          </div>
        ) : html ? (
          <iframe
            ref={iframeRef}
            srcDoc={html}
            title="Campaign brief preview"
            className="h-full w-full border-0"
          />
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
