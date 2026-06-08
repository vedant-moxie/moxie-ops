"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * Shared per-column filter primitives for the main data tables (Orders, GRN,
 * Allocation). Categorical → Select with an "All" option, text → debounced
 * search Input, numeric/date → compact min/max range. All filtering is
 * client-side via useMemo in each table; these components are presentational
 * and are dropped into the column-header popovers (see ./column-filter).
 */

/** Debounce a rapidly-changing value (e.g. a text input) for use in filtering. */
export function useDebounced<T>(value: T, delay = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/** Debounced text search input. Caller owns the raw value; debounce in the table. */
export function SearchFilter({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn("h-9 w-[190px]", className)}
    />
  );
}

/**
 * Categorical Select with a built-in "All" option (value "all"). Pass the
 * option <SelectItem>s as children so callers control rendering (e.g. channel
 * chips vs enum labels).
 */
export function SelectFilter({
  value,
  onChange,
  allLabel,
  width = "w-[170px]",
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  allLabel: string;
  width?: string;
  children: ReactNode;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn("h-9", width)}>
        <SelectValue placeholder={allLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{allLabel}</SelectItem>
        {children}
      </SelectContent>
    </Select>
  );
}

/** Compact numeric min/max range. */
export function NumberRangeFilter({
  min,
  max,
  onMin,
  onMax,
  minPlaceholder = "Min",
  maxPlaceholder = "Max",
}: {
  min: string;
  max: string;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
  minPlaceholder?: string;
  maxPlaceholder?: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <Input
        type="number"
        inputMode="numeric"
        value={min}
        onChange={(e) => onMin(e.target.value)}
        placeholder={minPlaceholder}
        className="h-9 w-[100px]"
      />
      <span className="text-muted-foreground">–</span>
      <Input
        type="number"
        inputMode="numeric"
        value={max}
        onChange={(e) => onMax(e.target.value)}
        placeholder={maxPlaceholder}
        className="h-9 w-[100px]"
      />
    </div>
  );
}

/** Compact date range (two native date inputs). */
export function DateRangeFilter({
  from,
  to,
  onFrom,
  onTo,
}: {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Input
        type="date"
        value={from}
        onChange={(e) => onFrom(e.target.value)}
        className="h-9 w-[150px]"
      />
      <span className="text-muted-foreground">–</span>
      <Input
        type="date"
        value={to}
        onChange={(e) => onTo(e.target.value)}
        className="h-9 w-[150px]"
      />
    </div>
  );
}

/** True when `value` falls within [min, max]; empty bounds are open-ended. */
export function inNumberRange(value: number | null, min: string, max: string): boolean {
  if (!min && !max) return true;
  const v = value ?? 0;
  if (min !== "" && v < Number(min)) return false;
  if (max !== "" && v > Number(max)) return false;
  return true;
}

/** True when `value` (a date) falls within [from, to]; empty bounds are open-ended. */
export function inDateRange(
  value: Date | string | null,
  from: string,
  to: string,
): boolean {
  if (!from && !to) return true;
  if (!value) return false;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return false;
  if (from && t < new Date(`${from}T00:00:00`).getTime()) return false;
  if (to && t > new Date(`${to}T23:59:59.999`).getTime()) return false;
  return true;
}
