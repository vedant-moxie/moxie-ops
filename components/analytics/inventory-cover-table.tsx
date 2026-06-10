"use client";

import { useState } from "react";
import { ArrowUpDown } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn, formatNumber } from "@/lib/utils";

export type CoverStage = "CRITICAL" | "RESTOCK" | "UNDER_CHECK" | "OVERSTOCKED" | "NO_DATA";

export interface InventoryCoverRow {
  skuCode: string;
  skuName: string;
  soh: number;
  outward7d: number;
  outward30d: number;
  drr7d: number;
  drr30d: number;
  cover: number | null;
  stage: CoverStage;
}

const STAGE_META: Record<CoverStage, { label: string; className: string }> = {
  CRITICAL: { label: "CRITICAL", className: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300 border-red-200 dark:border-red-800" },
  RESTOCK: { label: "RESTOCK", className: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300 border-amber-200 dark:border-amber-800" },
  UNDER_CHECK: { label: "UNDER CHECK", className: "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300 border-blue-200 dark:border-blue-800" },
  OVERSTOCKED: { label: "OVERSTOCKED", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800" },
  NO_DATA: { label: "NO DATA", className: "bg-muted text-muted-foreground" },
};

const ROW_ACCENT: Record<CoverStage, string> = {
  CRITICAL: "bg-red-50/40 dark:bg-red-950/10",
  RESTOCK: "bg-amber-50/30 dark:bg-amber-950/10",
  UNDER_CHECK: "",
  OVERSTOCKED: "",
  NO_DATA: "",
};

type SortKey = "skuCode" | "soh" | "outward7d" | "outward30d" | "drr7d" | "drr30d" | "cover" | "stage";

export function InventoryCoverTable({ rows: initialRows }: { rows: InventoryCoverRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("cover");
  const [sortAsc, setSortAsc] = useState(true);

  const stageOrder: Record<CoverStage, number> = { CRITICAL: 0, RESTOCK: 1, UNDER_CHECK: 2, OVERSTOCKED: 3, NO_DATA: 4 };

  const sorted = [...initialRows].sort((a, b) => {
    let diff = 0;
    switch (sortKey) {
      case "skuCode": diff = a.skuCode.localeCompare(b.skuCode); break;
      case "soh": diff = a.soh - b.soh; break;
      case "outward7d": diff = a.outward7d - b.outward7d; break;
      case "outward30d": diff = a.outward30d - b.outward30d; break;
      case "drr7d": diff = a.drr7d - b.drr7d; break;
      case "drr30d": diff = a.drr30d - b.drr30d; break;
      case "cover": diff = (a.cover ?? 9999) - (b.cover ?? 9999); break;
      case "stage": diff = stageOrder[a.stage] - stageOrder[b.stage]; break;
    }
    return sortAsc ? diff : -diff;
  });

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(true); }
  };

  const Th = ({ col, label }: { col: SortKey; label: string }) => (
    <TableHead
      className="cursor-pointer select-none whitespace-nowrap"
      onClick={() => toggleSort(col)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <ArrowUpDown className={cn("h-3 w-3 opacity-40", sortKey === col && "opacity-100 text-foreground")} />
      </span>
    </TableHead>
  );

  const summary = {
    critical: initialRows.filter((r) => r.stage === "CRITICAL").length,
    restock: initialRows.filter((r) => r.stage === "RESTOCK").length,
    underCheck: initialRows.filter((r) => r.stage === "UNDER_CHECK").length,
    overstocked: initialRows.filter((r) => r.stage === "OVERSTOCKED").length,
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-sm">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
          <span className="font-semibold nums">{summary.critical}</span> Critical
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <span className="font-semibold nums">{summary.restock}</span> Restock
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 text-blue-800 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
          <span className="font-semibold nums">{summary.underCheck}</span> Under check
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
          <span className="font-semibold nums">{summary.overstocked}</span> Overstocked
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border/70">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <Th col="skuCode" label="SKU Code" />
              <Th col="soh" label="SOH" />
              <Th col="outward7d" label="7D Out" />
              <Th col="outward30d" label="30D Out" />
              <Th col="drr7d" label="7D DRR" />
              <Th col="drr30d" label="30D DRR" />
              <Th col="cover" label="Cover (d)" />
              <Th col="stage" label="Stage" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((r) => (
              <TableRow key={r.skuCode} className={cn("text-sm", ROW_ACCENT[r.stage])}>
                <TableCell>
                  <div className="font-mono text-xs font-semibold">{r.skuCode}</div>
                  <div className="max-w-[200px] truncate text-[11px] text-muted-foreground">{r.skuName}</div>
                </TableCell>
                <TableCell className="text-right nums">{formatNumber(r.soh)}</TableCell>
                <TableCell className="text-right nums">{formatNumber(r.outward7d)}</TableCell>
                <TableCell className="text-right nums">{formatNumber(r.outward30d)}</TableCell>
                <TableCell className="text-right nums">{r.drr7d}</TableCell>
                <TableCell className="text-right nums">{r.drr30d}</TableCell>
                <TableCell
                  className={cn(
                    "text-right nums font-semibold",
                    r.cover !== null && r.cover < 20 && "text-red-600 dark:text-red-400",
                    r.cover !== null && r.cover >= 20 && r.cover < 60 && "text-amber-600 dark:text-amber-400",
                  )}
                >
                  {r.cover !== null ? r.cover : "—"}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={cn("text-[11px] font-semibold tracking-wide", STAGE_META[r.stage].className)}
                  >
                    {STAGE_META[r.stage].label}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Cover = SOH ÷ max(7D DRR, 30D DRR) · DRR = outward units ÷ days · Thresholds: &lt;20 critical · 20–60 restock · 60–90 under check · &gt;90 overstocked
      </p>
    </div>
  );
}
