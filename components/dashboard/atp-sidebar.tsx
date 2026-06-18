"use client";

import { useCallback, useEffect, useState } from "react";
import { Boxes, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn, formatNumber } from "@/lib/utils";
import type { LiveAtpRow } from "@/lib/services/live-atp";

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

export function AtpSidebar({ initial }: { initial: LiveAtpRow[] }) {
  const [rows, setRows] = useState<LiveAtpRow[]>(initial);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async (force = false) => {
    try {
      setRefreshing(true);
      const res = await fetch(`/api/dashboard/live-atp${force ? "?force=1" : ""}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (json.success) setRows(json.data);
    } catch {
      /* keep last */
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const id = setInterval(() => refresh(false), 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const maxAtp = Math.max(1, ...rows.map((r) => Math.max(r.atpQty, r.demand)));

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Boxes className="h-[18px] w-[18px] text-muted-foreground" />
          <h3 className="text-sm font-semibold">Live ATP</h3>
        </div>
        <button
          type="button"
          onClick={() => refresh(true)}
          disabled={refreshing}
          aria-label="Refresh ATP"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
        </button>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Top SKUs by today&apos;s demand · refreshes every 30s
      </p>

      {rows.length === 0 ? (
        <p className="mt-6 text-center text-xs text-muted-foreground">
          No POs today — nothing to promise yet.
        </p>
      ) : (
        <div className="mt-4 space-y-3.5">
          {rows.map((r) => {
            const h = health(r.atpQty, r.demand);
            return (
              <div key={r.code}>
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className="truncate text-[13px] font-semibold nums"
                    title={r.name || undefined}
                  >
                    {r.code}
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
                  ordered {formatNumber(r.demand)} · ATP {formatNumber(r.atpQty)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
