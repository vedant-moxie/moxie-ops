"use client";

import { useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sparkles, Check, Loader2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PriorityBadge } from "@/components/dashboard/priority-badge";
import { cn, formatINR, formatNumber, roundToCasePack } from "@/lib/utils";
import type { AtpRow } from "@/lib/integrations/wms-atp";

interface SkuMeta {
  skuId: string;
  internalCode: string;
  name: string;
  casePackSize: number;
}
interface PoForGrid {
  id: string;
  channelPoNumber: string | null;
  priority: string | null;
  totalRequestedValue: number | null;
  channel: { name: string; logoColor: string | null };
  lineItems: {
    skuId: string;
    requestedQty: number;
    approvedQty: number | null;
    sku: { internalCode: string; name: string; casePackSize: number };
  }[];
}

type Alloc = Record<string, number>; // `${poId}:${skuId}` → qty
const key = (poId: string, skuId: string) => `${poId}:${skuId}`;

export function AllocationGrid({ pos, atp }: { pos: PoForGrid[]; atp: AtpRow[] }) {
  const router = useRouter();

  // Unique SKUs appearing in these POs (column order)
  const skus = useMemo<SkuMeta[]>(() => {
    const map = new Map<string, SkuMeta>();
    for (const po of pos) {
      for (const li of po.lineItems) {
        if (!map.has(li.skuId)) {
          map.set(li.skuId, {
            skuId: li.skuId,
            internalCode: li.sku.internalCode,
            name: li.sku.name,
            casePackSize: li.sku.casePackSize,
          });
        }
      }
    }
    return [...map.values()];
  }, [pos]);

  const atpById = useMemo(() => new Map(atp.map((a) => [a.skuId, a])), [atp]);
  const requestedByCell = useMemo(() => {
    const m = new Map<string, number>();
    for (const po of pos)
      for (const li of po.lineItems) m.set(key(po.id, li.skuId), li.requestedQty);
    return m;
  }, [pos]);

  const [alloc, setAlloc] = useState<Alloc>(() => {
    const init: Alloc = {};
    for (const po of pos)
      for (const li of po.lineItems)
        init[key(po.id, li.skuId)] = li.approvedQty ?? 0;
    return init;
  });
  const [suggesting, setSuggesting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [approving, setApproving] = useState(false);

  // Per-SKU allocated totals + remaining ATP
  const allocatedBySku = useMemo(() => {
    const m = new Map<string, number>();
    for (const [k, v] of Object.entries(alloc)) {
      const skuId = k.split(":")[1]!;
      m.set(skuId, (m.get(skuId) ?? 0) + (v || 0));
    }
    return m;
  }, [alloc]);

  const setCell = useCallback(
    (poId: string, skuId: string, raw: string) => {
      const n = Math.max(0, Math.floor(Number(raw) || 0));
      setAlloc((prev) => ({ ...prev, [key(poId, skuId)]: n }));
    },
    [],
  );

  const snapToCasePack = useCallback(
    (poId: string, skuId: string) => {
      setAlloc((prev) => {
        const meta = skus.find((s) => s.skuId === skuId);
        const requested = requestedByCell.get(key(poId, skuId)) ?? 0;
        const cur = prev[key(poId, skuId)] ?? 0;
        if (!meta || cur === 0) return prev;
        const snapped = Math.min(roundToCasePack(cur, meta.casePackSize), requested);
        return { ...prev, [key(poId, skuId)]: snapped };
      });
    },
    [skus, requestedByCell],
  );

  async function regenerate() {
    setSuggesting(true);
    try {
      const res = await fetch("/api/allocations/suggest", { method: "POST" });
      const json = await res.json();
      if (!json.success) throw new Error();
      const next: Alloc = { ...alloc };
      for (const a of json.data.allocations as { po_id: string; sku_id: string; suggested_qty: number }[]) {
        if (requestedByCell.has(key(a.po_id, a.sku_id)))
          next[key(a.po_id, a.sku_id)] = a.suggested_qty;
      }
      setAlloc(next);
      toast.success(
        json.data.source === "ai"
          ? "AI suggestions applied"
          : "Suggestions applied (priority-greedy)",
      );
    } catch {
      toast.error("Couldn't generate suggestions");
    } finally {
      setSuggesting(false);
    }
  }

  // Every PO must have at least one qty filled
  const allFilled = pos.every((po) =>
    po.lineItems.some((li) => (alloc[key(po.id, li.skuId)] ?? 0) > 0),
  );
  const anyOver = skus.some((s) => (allocatedBySku.get(s.skuId) ?? 0) > (atpById.get(s.skuId)?.atpQty ?? 0));

  // Approval summary by channel
  const summary = useMemo(() => {
    const byChannel = new Map<string, { units: number; value: number }>();
    let totalUnits = 0;
    for (const po of pos) {
      const agg = byChannel.get(po.channel.name) ?? { units: 0, value: 0 };
      for (const li of po.lineItems) {
        const q = alloc[key(po.id, li.skuId)] ?? 0;
        agg.units += q;
        totalUnits += q;
      }
      byChannel.set(po.channel.name, agg);
    }
    return { byChannel: [...byChannel.entries()], totalUnits };
  }, [pos, alloc]);

  async function approveAll() {
    setApproving(true);
    try {
      const payload = {
        allocations: pos.map((po) => ({
          poId: po.id,
          lines: po.lineItems.map((li) => ({
            skuId: li.skuId,
            approvedQty: alloc[key(po.id, li.skuId)] ?? 0,
          })),
        })),
      };
      const res = await fetch("/api/allocations/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast.success(`Allocation approved · ${json.data.approved} warehouse emails sent`);
      router.push("/orders");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Approval failed");
    } finally {
      setApproving(false);
      setConfirmOpen(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* AI banner */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-lime/40 bg-lime-soft/60 px-4 py-3">
        <Sparkles className="h-4 w-4 text-[hsl(72_60%_28%)]" />
        <p className="flex-1 text-sm text-[hsl(72_50%_22%)]">
          Quantities are pre-filled by priority (P1 → P2 → P3) against live ATP. Review and adjust.
        </p>
        <Button variant="outline" size="sm" onClick={regenerate} disabled={suggesting}>
          {suggesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Re-generate
        </Button>
      </div>

      {/* Grid */}
      <div className="overflow-auto rounded-xl border border-border/70 bg-card shadow-soft">
        <table className="w-full border-collapse text-sm">
          {/* ATP strip */}
          <thead className="sticky top-0 z-20">
            <tr className="bg-[hsl(44_30%_96%)]">
              <th
                className="sticky left-0 z-30 min-w-[260px] bg-[hsl(44_30%_96%)] px-4 py-2 text-left align-bottom"
                colSpan={1}
              >
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Live ATP →
                </span>
              </th>
              {skus.map((s) => {
                const a = atpById.get(s.skuId);
                const atpQty = a?.atpQty ?? 0;
                const allocated = allocatedBySku.get(s.skuId) ?? 0;
                const remaining = atpQty - allocated;
                const over = remaining < 0;
                const ratio = atpQty > 0 ? Math.max(0, remaining) / atpQty : 0;
                const tone = over ? "bg-danger" : ratio > 0.5 ? "bg-success" : ratio > 0.15 ? "bg-warning" : "bg-danger";
                return (
                  <th key={s.skuId} className="min-w-[116px] px-2 py-2 text-center align-bottom">
                    <div className="text-[12px] font-semibold">{s.internalCode}</div>
                    <div className={cn("text-[11px] nums", over ? "text-danger" : "text-muted-foreground")}>
                      {formatNumber(remaining)} left
                    </div>
                    <div className="mx-auto mt-1 h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                      <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} />
                    </div>
                  </th>
                );
              })}
            </tr>
            <tr className="border-b border-border bg-card">
              <th className="sticky left-0 z-30 min-w-[260px] bg-card px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Purchase order
              </th>
              {skus.map((s) => (
                <th key={s.skuId} className="px-2 py-2.5 text-center text-[11px] font-medium text-muted-foreground">
                  pack {s.casePackSize}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pos.map((po) => (
              <tr key={po.id} className="border-b border-border/50 last:border-0 hover:bg-muted/30">
                <td className="sticky left-0 z-10 min-w-[260px] bg-card px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <span
                      className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[10px] font-bold text-white"
                      style={{ backgroundColor: po.channel.logoColor ?? "#1a1a2e" }}
                    >
                      {po.channel.name.slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium">{po.channelPoNumber}</div>
                      <div className="text-[11px] text-muted-foreground nums">
                        {formatINR(po.totalRequestedValue)}
                      </div>
                    </div>
                    <div className="ml-auto">
                      <PriorityBadge poId={po.id} priority={po.priority} editable={false} />
                    </div>
                  </div>
                </td>
                {skus.map((s) => {
                  const requested = requestedByCell.get(key(po.id, s.skuId));
                  if (requested == null) {
                    return <td key={s.skuId} className="bg-[hsl(44_20%_97%)] px-2 py-2.5 text-center text-muted-foreground/40">—</td>;
                  }
                  const val = alloc[key(po.id, s.skuId)] ?? 0;
                  const over = (allocatedBySku.get(s.skuId) ?? 0) > (atpById.get(s.skuId)?.atpQty ?? 0);
                  const tone =
                    val === 0 ? "bg-[hsl(0_72%_56%/0.08)]"
                      : val >= requested ? "bg-[hsl(158_64%_42%/0.12)]"
                      : "bg-[hsl(38_92%_50%/0.13)]";
                  return (
                    <td key={s.skuId} className={cn("px-1.5 py-1.5 text-center", tone)}>
                      <input
                        type="number"
                        min={0}
                        max={requested}
                        value={val || ""}
                        onChange={(e) => setCell(po.id, s.skuId, e.target.value)}
                        onBlur={() => snapToCasePack(po.id, s.skuId)}
                        className={cn(
                          "h-9 w-[88px] rounded-lg border bg-card/80 px-2 text-center text-sm nums outline-none transition-colors focus:ring-2 focus:ring-ring/40",
                          over ? "border-danger" : "border-border/60",
                        )}
                      />
                      <div className="mt-0.5 text-[10px] text-muted-foreground nums">of {requested}</div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border bg-[hsl(44_30%_96%)]">
              <td className="sticky left-0 z-10 bg-[hsl(44_30%_96%)] px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Allocated
              </td>
              {skus.map((s) => {
                const allocated = allocatedBySku.get(s.skuId) ?? 0;
                const over = allocated > (atpById.get(s.skuId)?.atpQty ?? 0);
                return (
                  <td key={s.skuId} className={cn("px-2 py-2.5 text-center text-sm font-semibold nums", over && "text-danger")}>
                    {formatNumber(allocated)}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Footer actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {anyOver ? (
            <Badge variant="danger">Over-allocated — reduce highlighted cells</Badge>
          ) : allFilled ? (
            <Badge variant="success">Ready to approve</Badge>
          ) : (
            <Badge variant="warning">Fill at least one SKU per PO</Badge>
          )}
        </div>
        <Button size="lg" disabled={!allFilled || anyOver} onClick={() => setConfirmOpen(true)}>
          <Check className="h-4 w-4" />
          Approve all & email warehouse
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm allocation</DialogTitle>
            <DialogDescription>
              This approves {pos.length} PO{pos.length === 1 ? "" : "s"} ({formatNumber(summary.totalUnits)} units)
              and emails picking lists to the warehouse.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 rounded-lg bg-muted/50 p-3">
            {summary.byChannel.map(([name, agg]) => (
              <div key={name} className="flex items-center justify-between text-sm">
                <span className="font-medium">{name}</span>
                <span className="text-muted-foreground nums">{formatNumber(agg.units)} units</span>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={approving}>
              Cancel
            </Button>
            <Button onClick={approveAll} disabled={approving}>
              {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Confirm & send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
