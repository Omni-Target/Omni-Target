"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Calendar,
  ChevronRight,
  FileText,
  Layers,
  Search,
} from "lucide-react";
import { PageContainer } from "@/components/layout/page-container";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  BRIEFS_QUERY_KEY,
  fetchBriefHistory,
  type BriefListItem,
} from "@/components/campaigns/brief-history";

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

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const s = status.toLowerCase();
  const done = ["complete", "active", "launched"].includes(s);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold shadow-xs",
        done
          ? "bg-success-50 text-success-600"
          : "bg-surface text-subtle-foreground",
      )}
    >
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </span>
  );
}

function BriefCard({ b }: { b: BriefListItem }) {
  const [imgOk, setImgOk] = useState(true);
  const title = b.headline || b.product_name || "Untitled brief";
  const subtitle =
    b.headline && b.product_name
      ? b.product_name
      : (b.brand_name ?? b.product_description ?? "");

  return (
    <Link href={`/campaigns/${b.id}`} className="group block">
      <Card interactive className="flex h-full flex-col overflow-hidden">
        <div className="relative aspect-[16/10] w-full overflow-hidden bg-gradient-to-br from-brand-50 via-surface to-surface-subtle">
          {b.media_url && imgOk ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={b.media_url}
              alt=""
              onError={() => setImgOk(false)}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            />
          ) : (
            <div className="grid h-full place-items-center text-brand-700">
              <FileText className="size-8" />
            </div>
          )}
          <span className="absolute left-3 top-3">
            <StatusBadge status={b.status} />
          </span>
        </div>

        <div className="flex flex-1 flex-col p-4">
          <h3 className="line-clamp-2 text-sm font-semibold text-foreground">
            {title}
          </h3>
          {subtitle && (
            <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
              {subtitle}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {b.product_price && (
              <span className="font-semibold text-foreground">
                {b.product_price}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Layers className="size-3.5" />
              {b.variation_count} variation{b.variation_count === 1 ? "" : "s"}
            </span>
          </div>

          <div className="mt-auto flex items-center justify-between pt-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Calendar className="size-3.5" />
              {formatDate(b.created_at)}
            </span>
            <span className="inline-flex items-center gap-1 font-medium text-brand-600 opacity-0 transition-opacity group-hover:opacity-100">
              Open <ChevronRight className="size-3.5" />
            </span>
          </div>
        </div>
      </Card>
    </Link>
  );
}

/** Full-page, searchable, date-filterable grid of every finalized brief. */
export default function BriefsPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: BRIEFS_QUERY_KEY,
    queryFn: fetchBriefHistory,
  });
  const items = useMemo(() => data ?? [], [data]);

  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const hasFilters = !!(search.trim() || fromDate || toDate);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const from = fromDate ? new Date(`${fromDate}T00:00:00`) : null;
    const to = toDate ? new Date(`${toDate}T23:59:59`) : null;
    return items.filter((b) => {
      if (q) {
        const hay = [
          b.product_name,
          b.brand_name,
          b.headline,
          b.product_description,
          b.cta,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (from || to) {
        const created = b.created_at ? new Date(b.created_at) : null;
        if (!created) return false;
        if (from && created < from) return false;
        if (to && created > to) return false;
      }
      return true;
    });
  }, [items, search, fromDate, toDate]);

  const clearFilters = () => {
    setSearch("");
    setFromDate("");
    setToDate("");
  };

  return (
    <PageContainer width="wide" className="space-y-6 pb-16">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground sm:text-3xl">
            Your briefs
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every brief you&apos;ve generated. Open one to review, switch
            variations, or re-download.
          </p>
        </div>
      </div>

      {/* Filters */}
      {(items.length > 0 || hasFilters) && !isLoading && !isError && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by product, brand, headline…"
              aria-label="Search briefs"
              className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm text-foreground shadow-xs outline-none transition-colors placeholder:text-subtle-foreground focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
            />
          </div>
          {/* <div className="flex items-center gap-2">
            <input
              type="date"
              value={fromDate}
              max={toDate || undefined}
              onChange={(e) => setFromDate(e.target.value)}
              aria-label="From date"
              className={dateInputClass}
            />
            <span className="text-sm text-subtle-foreground">–</span>
            <input
              type="date"
              value={toDate}
              min={fromDate || undefined}
              onChange={(e) => setToDate(e.target.value)}
              aria-label="To date"
              className={dateInputClass}
            />
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="size-4" /> Clear
              </Button>
            )}
          </div> */}
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : isError ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          Couldn&apos;t load your briefs. Please refresh.
        </Card>
      ) : items.length === 0 ? (
        <Card className="p-12 text-center">
          <FileText className="mx-auto mb-3 size-8 text-faint-foreground" />
          <p className="text-base font-medium text-foreground">No briefs yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Generate your first campaign brief and it&apos;ll show up here for
            you to revisit any time.
          </p>
          <Button asChild className="mt-5">
            <Link href="/campaigns">Generate a brief</Link>
          </Button>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="p-12 text-center">
          <Search className="mx-auto mb-3 size-7 text-faint-foreground" />
          <p className="text-sm font-medium text-foreground">
            No briefs match your filters
          </p>
          <Button variant="secondary" className="mt-4" onClick={clearFilters}>
            Clear filters
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((b) => (
            <BriefCard key={b.id} b={b} />
          ))}
        </div>
      )}
    </PageContainer>
  );
}
