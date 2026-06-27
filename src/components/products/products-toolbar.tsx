"use client";

import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";

export type SortKey = "best" | "revenue" | "price_high" | "price_low" | "name";
export type StockFilter = "all" | "in" | "out";

export function ProductsToolbar({
  search,
  onSearch,
  sort,
  onSort,
  filter,
  onFilter,
  inCount,
  outCount,
}: {
  search: string;
  onSearch: (v: string) => void;
  sort: SortKey;
  onSort: (v: SortKey) => void;
  filter: StockFilter;
  onFilter: (v: StockFilter) => void;
  inCount: number;
  outCount: number;
}) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="lg:max-w-xs lg:flex-1">
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search products…"
          startIcon={<Search />}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          value={filter}
          onChange={onFilter}
          options={[
            { label: "All", value: "all" },
            { label: `In stock · ${inCount}`, value: "in" },
            { label: `Out · ${outCount}`, value: "out" },
          ]}
        />
        <Select
          value={sort}
          onChange={(e) => onSort(e.target.value as SortKey)}
          className="h-9 w-auto min-w-[10rem] text-[0.8125rem]"
        >
          <option value="best">Best selling</option>
          <option value="revenue">Highest revenue</option>
          <option value="price_high">Price: high to low</option>
          <option value="price_low">Price: low to high</option>
          <option value="name">Name: A–Z</option>
        </Select>
      </div>
    </div>
  );
}
