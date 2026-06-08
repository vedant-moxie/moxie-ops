"use client";

import { useEffect, useState } from "react";
import { Boxes, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn, formatNumber } from "@/lib/utils";
import { resolveInternalSkuAnyChannel } from "@/lib/services/sku-resolver";
import type { AtpRow } from "@/lib/integrations/sheets";

function health(atp: number, demand: number): "green" | "amber" | "red" {
  if (demand <= 0) return atp > 0 ? "green" : "red";
  const ratio = atp / demand;
  if (ratio > 1.5) return "green";
  if (ratio >= 0.5) return "amber";
  return "red";
}

const BAR: Record<string, string> = {
  green: "bg-success",
  amber: "bg-warning",
  red: "bg-danger",
};

export function AtpSidebar({
  initial,
  demand,
}: {
  initial: AtpRow[];
  demand: Record<string, number>;
}) {
  const [rows, setRows] = useState<AtpRow[]>(initial);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        setRefreshing(true);
        const res = await fetch("/api/inventory/atp", { cache: "no-store" });
        const json = await res.json();
        if (json.success) setRows(json.data);
      } catch {
        /* keep last */
      } finally {
        setRefreshing(false);
      }
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  const sorted = [...rows]
    .sort((a, b) => (demand[b.skuId] ?? 0) - (demand[a.skuId] ?? 0))
    .slice(0, 10);
  const maxAtp = Math.max(1, ...sorted.map((r) => Math.max(r.atpQty, demand[r.skuId] ?? 0)));

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Boxes className="h-[18px] w-[18px] text-muted-foreground" />
          <h3 className="text-sm font-semibold">Live ATP</h3>
        </div>
        <RefreshCw
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground",
            refreshing && "animate-spin",
          )}
        />
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Top SKUs by today&apos;s demand · refreshes every 30s
      </p>

      <div className="mt-4 space-y-3.5">
        {sorted.map((r) => {
          const d = demand[r.skuId] ?? 0;
          const h = health(r.atpQty, d);
          const internalCode = resolveInternalSkuAnyChannel(r.internalCode);
          return (
            <div key={r.skuId}>
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className="truncate text-[13px] font-semibold nums"
                  title={r.name || undefined}
                >
                  {internalCode}
                </span>
                <span className="shrink-0 text-[13px] font-semibold nums">
                  {formatNumber(r.atpQty)}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn("h-full rounded-full transition-all", BAR[h])}
                  style={{ width: `${Math.min(100, (r.atpQty / maxAtp) * 100)}%` }}
                />
              </div>
              <div className="mt-1 truncate text-[11px] text-muted-foreground">
                {r.name && <span className="mr-1">{r.name} ·</span>}
                demand {formatNumber(d)} · ATP {formatNumber(r.atpQty)}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
