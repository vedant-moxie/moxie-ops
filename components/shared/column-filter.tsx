"use client";

import { useState, type ReactNode } from "react";
import { Filter } from "lucide-react";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Per-column header filter — a small filter icon embedded in a table column
 * header that opens a popover holding that column's filter control(s). Used by
 * the Orders / GRN / Allocation tables in place of a big always-visible filter
 * bar. The icon fills + tints when the column has an active filter.
 *
 * Pair with the filter primitives in ./table-filters (SearchFilter, SelectFilter,
 * NumberRangeFilter, DateRangeFilter) as the popover children.
 */
export function ColumnFilter({
  label,
  active,
  onClear,
  align = "left",
  children,
}: {
  label: string;
  active: boolean;
  onClear?: () => void;
  /** Match the column's text alignment so the icon sits on the right edge for numeric columns. */
  align?: "left" | "right";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={cn(
        "flex items-center gap-1",
        align === "right" && "justify-end",
      )}
    >
      <span>{label}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Filter ${label}`}
            className={cn(
              "inline-flex h-5 w-5 items-center justify-center rounded transition-colors",
              active
                ? "text-primary"
                : "text-muted-foreground/50 hover:bg-muted hover:text-foreground",
            )}
          >
            <Filter className={cn("h-3 w-3", active && "fill-current")} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align={align === "right" ? "end" : "start"}
          className="w-auto min-w-[220px] p-3"
        >
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {label}
              </span>
              {active && onClear && (
                <button
                  type="button"
                  onClick={onClear}
                  className="text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  Clear
                </button>
              )}
            </div>
            {children}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
