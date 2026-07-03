"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FileText } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

export interface BriefListItem {
  id: string;
  brand_name: string | null;
  product_name: string | null;
  product_description: string | null;
  product_price: string | null;
  media_url: string | null;
  headline: string | null;
  cta: string | null;
  status: string | null;
  created_at: string | null;
  variation_count: number;
}

// Shared with the campaigns page, which invalidates it after a brief is
// finalized so the history reflects the new brief without a refresh.
export const BRIEFS_QUERY_KEY = ["campaigns", "list"] as const;

export async function fetchBriefHistory(): Promise<BriefListItem[]> {
  const res = await fetch("/api/campaigns");
  if (!res.ok) throw new Error("Failed to load briefs");
  const data = await res.json();
  return (data.campaigns as BriefListItem[]) ?? [];
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

/** Recent finalized briefs, each linking to its durable /campaigns/[id] page. */
export function BriefHistory({ limit = 5 }: { limit?: number }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: BRIEFS_QUERY_KEY,
    queryFn: fetchBriefHistory,
  });

  const items = (data ?? []).slice(0, limit);

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-widest text-subtle-foreground">
          Recent briefs
        </h3>
        <Link
          href="/campaigns"
          className="text-xs font-medium text-brand-600 hover:underline"
        >
          New brief
        </Link>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : isError ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Couldn&apos;t load your briefs.
        </p>
      ) : items.length === 0 ? (
        <div className="py-8 text-center">
          <FileText className="mx-auto mb-2 size-6 text-faint-foreground" />
          <p className="text-sm text-muted-foreground">No briefs yet.</p>
          <Link
            href="/campaigns"
            className="mt-2 inline-block text-sm font-medium text-brand-600 hover:underline"
          >
            Generate your first brief
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((b) => (
            <li key={b.id}>
              <Link
                href={`/campaigns/${b.id}`}
                className="group -mx-2 flex items-center gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-surface-subtle"
              >
                <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
                  <FileText className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {b.product_name || b.brand_name || "Untitled brief"}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {b.headline || "—"}
                  </p>
                </div>
                <p className="shrink-0 text-xs text-muted-foreground">
                  {formatDate(b.created_at)}
                </p>
                <ChevronRight className="size-4 shrink-0 text-faint-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
