"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Toolbar that sits above the main data tables. Replaces the old big filter bar
 * (filters now live in the column headers — see ./column-filter). Holds the
 * table-size/density control, removable chips for each active column filter, a
 * "Clear all" action, and the "showing N of M" count.
 */

export type TableDensity = "compact" | "normal" | "comfortable";

/**
 * Tailwind classes applied to the <Table> for a given density. `whitespace-nowrap`
 * keeps every cell on one line so columns are never clipped — the table grows
 * past the viewport and its overflow-auto wrapper scrolls horizontally instead.
 */
const DENSITY_CLASS: Record<TableDensity, string> = {
  compact:
    "whitespace-nowrap text-xs [&_th]:h-9 [&_th]:px-2.5 [&_th]:py-1 [&_td]:px-2.5 [&_td]:py-1.5",
  normal: "whitespace-nowrap",
  comfortable:
    "whitespace-nowrap text-[15px] [&_th]:px-5 [&_td]:px-5 [&_td]:py-4",
};

export function densityClass(d: TableDensity): string {
  return DENSITY_CLASS[d];
}

/** Density state persisted to localStorage under `storageKey`. */
export function useTableDensity(
  storageKey: string,
): [TableDensity, (d: TableDensity) => void] {
  const [density, setDensity] = useState<TableDensity>("normal");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved === "compact" || saved === "normal" || saved === "comfortable") {
        setDensity(saved);
      }
    } catch {
      /* ignore unavailable storage */
    }
  }, [storageKey]);

  function update(d: TableDensity) {
    setDensity(d);
    try {
      window.localStorage.setItem(storageKey, d);
    } catch {
      /* ignore unavailable storage */
    }
  }

  return [density, update];
}

export interface FilterChipDef {
  key: string;
  label: string;
  onRemove: () => void;
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/50 px-2 py-0.5 text-xs">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

export function TableToolbar({
  chips,
  onClearAll,
  count,
  total,
  noun = "rows",
  children,
}: {
  chips: FilterChipDef[];
  onClearAll: () => void;
  count: number;
  total: number;
  noun?: string;
  /** Extra controls (e.g. bulk-send button) rendered before the count. */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-5 pb-3 pt-1">
      {chips.map((c) => (
        <FilterChip key={c.key} label={c.label} onRemove={c.onRemove} />
      ))}
      {chips.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onClearAll}
          className="h-7 gap-1 text-muted-foreground"
        >
          <X className="h-3.5 w-3.5" /> Clear all
        </Button>
      )}
      {children}
      <span className="ml-auto text-sm text-muted-foreground">
        {count === total
          ? `${total} ${noun}`
          : `showing ${count} of ${total} ${noun}`}
      </span>
    </div>
  );
}
