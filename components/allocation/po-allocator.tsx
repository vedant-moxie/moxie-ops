"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Wand2, PackageCheck, Mail, Trash2, Undo2, Warehouse } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { cn, formatNumber } from "@/lib/utils";

export interface WarehouseStockEntry {
  warehouseCode: string;
  warehouseName: string;
  /** Free available saleable units (WMS free minus allocations since last sync) */
  freeQty: number;
  /** Total saleable on hand in WMS */
  totalQty: number;
  syncedAt: string;
}
/** skuId → per-warehouse entries */
export type WarehouseStockBySku = Record<string, WarehouseStockEntry[]>;

interface Line {
  id: string;
  skuId: string;
  channelSkuCode: string | null;
  requestedQty: number;
  approvedQty: number | null;
  rawData: Record<string, string> | null;
  sku: { internalCode: string; name: string; uom: string };
  flag?: { mismatch: boolean; unmapped: boolean; reason: string } | null;
}

export function PoAllocator({
  poId,
  lines,
  receivedBySku,
  warehouseStock = {},
  dispatchWarehouseCode = null,
  dispatchWarehouseName = null,
  hasTaxableMismatch = false,
  lockedByOther = false,
}: {
  poId: string;
  lines: Line[];
  receivedBySku: Record<string, number>;
  warehouseStock?: WarehouseStockBySku;
  /** Warehouse that ships this PO (resolved from the GSTIN on the PO PDF) */
  dispatchWarehouseCode?: string | null;
  dispatchWarehouseName?: string | null;
  hasTaxableMismatch?: boolean;
  lockedByOther?: boolean;
}) {
  const router = useRouter();
  // Locked = another user holds the claim. Starts from the server's view, and the
  // claim-on-mount below upgrades it to true if someone grabbed it between SSR & mount.
  const [locked, setLocked] = useState(lockedByOther);

  // Acquire the claim when this page mounts (so others see it locked); release it on
  // unmount/navigation. The atomic server gate is the real guard — this is the UX.
  useEffect(() => {
    if (lockedByOther) return;
    let active = true;
    fetch(`/api/pos/${poId}/claim`, { method: "POST" })
      .then((r) => r.json())
      .then((j) => {
        if (active && j?.success && j.data?.ok === false) {
          setLocked(true);
          toast.warning(`This PO is being allocated by ${j.data.claimedByLabel ?? "another user"}.`);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
      // Best-effort release; keepalive lets it complete during navigation.
      fetch(`/api/pos/${poId}/claim`, { method: "DELETE", keepalive: true }).catch(() => {});
    };
  }, [poId, lockedByOther]);
  const [alloc, setAlloc] = useState<Record<string, number>>(() =>
    Object.fromEntries(lines.map((l) => [l.skuId, l.approvedQty ?? l.requestedQty ?? 0])),
  );
  const [rawInputs, setRawInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.skuId, String(l.approvedQty ?? l.requestedQty ?? 0)])),
  );
  const [saving, setSaving] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  // SKUs removed from this allocation (e.g. unmapped / not-for-sale) — excluded
  // from the saved allocation and the prep email.
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  const toggleRemove = (skuId: string) =>
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(skuId)) next.delete(skuId);
      else next.add(skuId);
      return next;
    });

  const set = (skuId: string, raw: string) => {
    setRawInputs((p) => ({ ...p, [skuId]: raw }));
    setAlloc((p) => ({ ...p, [skuId]: Math.max(0, Math.floor(Number(raw) || 0)) }));
  };

  const fillOrdered = () => {
    setAlloc(Object.fromEntries(lines.map((l) => [l.skuId, l.requestedQty])));
    setRawInputs(Object.fromEntries(lines.map((l) => [l.skuId, String(l.requestedQty)])));
  };
  const matchReceived = () => {
    const nums = Object.fromEntries(lines.map((l) => [l.skuId, receivedBySku[l.skuId] ?? 0]));
    setAlloc(nums);
    setRawInputs(Object.fromEntries(Object.entries(nums).map(([k, v]) => [k, String(v)])));
  };

  const totalOrdered = lines.reduce((s, l) => s + l.requestedQty, 0);
  const totalAlloc = lines.reduce((s, l) => s + (removed.has(l.skuId) ? 0 : alloc[l.skuId] ?? 0), 0);
  const removedCount = lines.filter((l) => removed.has(l.skuId)).length;

  // Aggregate per-warehouse totals across all PO SKUs (for the summary panel)
  const whTotals = new Map<string, { name: string; totalFree: number }>();
  let stockSyncedAt: string | null = null;
  for (const l of lines) {
    const entries = warehouseStock[l.skuId] ?? [];
    for (const e of entries) {
      const cur = whTotals.get(e.warehouseCode) ?? { name: e.warehouseName, totalFree: 0 };
      cur.totalFree += e.freeQty;
      whTotals.set(e.warehouseCode, cur);
      if (!stockSyncedAt || e.syncedAt > stockSyncedAt) stockSyncedAt = e.syncedAt;
    }
  }
  const hasWarehouseData = whTotals.size > 0;

  /** Free stock for one line at the dispatch warehouse (null when unknown). */
  const freeAtDispatch = (skuId: string): number | null => {
    if (!dispatchWarehouseCode) return null;
    const e = (warehouseStock[skuId] ?? []).find((x) => x.warehouseCode === dispatchWarehouseCode);
    return e ? e.freeQty : 0;
  };

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/pos/${poId}/allocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Removed lines are sent as 0 → excluded from the prep email.
          allocations: lines.map((l) => ({
            skuId: l.skuId,
            approvedQty: removed.has(l.skuId) ? 0 : alloc[l.skuId] ?? 0,
          })),
          // The confirm-send click acknowledges any price mismatch (server gate).
          acknowledge: confirmSend,
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      if (json.data?.mismatchWithheld) {
        toast.warning(
          `Allocation saved · email withheld — ${json.data.mismatches?.length ?? 0} price mismatch(es). Review and confirm to send.`,
        );
      } else {
        toast.success(`Allocation saved · ${formatNumber(totalAlloc)} units · email sent to abhishek@moxiebeauty.in`);
      }
      router.push("/allocate");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {hasWarehouseData && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-4 py-2.5">
          <Warehouse className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">Free stock:</span>
          {[...whTotals.entries()].map(([code, wh]) => {
            const isDispatch = code === dispatchWarehouseCode;
            return (
              <span
                key={code}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs",
                  isDispatch
                    ? "border-emerald-400 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/40"
                    : "border-border/60 bg-card",
                )}
              >
                <span className="font-mono font-semibold">{code}</span>
                <span className="text-muted-foreground">{wh.name !== code ? wh.name : ""}</span>
                <span className="font-semibold nums text-foreground">{formatNumber(wh.totalFree)}</span>
                <span className="text-muted-foreground">units</span>
                {isDispatch && (
                  <Badge variant="outline" className="ml-1 border-emerald-500 px-1.5 py-0 text-[10px] text-emerald-700 dark:text-emerald-300">
                    ships this PO
                  </Badge>
                )}
              </span>
            );
          })}
          <span className="ml-auto text-[11px] text-muted-foreground">
            {dispatchWarehouseName
              ? `Ships from ${dispatchWarehouseName} (PO GSTIN)`
              : "Shipping warehouse unknown — no GSTIN match"}
            {stockSyncedAt ? ` · WMS sync ${new Date(stockSyncedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}` : ""}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={fillOrdered}>
          <Wand2 className="h-4 w-4" /> Fill all to ordered
        </Button>
        <Button variant="outline" size="sm" onClick={matchReceived}>
          <PackageCheck className="h-4 w-4" /> Match received
        </Button>
        <div className="ml-auto text-sm text-muted-foreground">
          Allocating <span className="font-semibold text-foreground nums">{formatNumber(totalAlloc)}</span> of{" "}
          <span className="nums">{formatNumber(totalOrdered)}</span> ordered units
          {removedCount > 0 && (
            <span className="ml-2 text-rose-600 dark:text-rose-400">· {removedCount} removed</span>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-soft">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Item ID</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>UOM</TableHead>
              <TableHead className="text-right">Ordered</TableHead>
              <TableHead className="text-right">Received</TableHead>
              {hasWarehouseData && (
                <TableHead className="text-right">
                  {dispatchWarehouseCode ? `Free @ ${dispatchWarehouseCode}` : "Free stock"}
                </TableHead>
              )}
              <TableHead className="text-right">Allocate</TableHead>
              <TableHead className="text-right">Remove</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => {
              const received = receivedBySku[l.skuId];
              const val = alloc[l.skuId] ?? 0;
              const isRemoved = removed.has(l.skuId);
              const tone =
                val === 0 ? "border-border/60"
                  : val >= l.requestedQty ? "border-success"
                  : "border-warning";
              return (
                <TableRow key={l.id} className={cn(isRemoved && "opacity-50")}>
                  <TableCell className="font-mono text-xs">{l.channelSkuCode ?? l.sku.internalCode}</TableCell>
                  <TableCell className="max-w-[320px]">
                    <div className={cn("truncate text-sm", isRemoved && "line-through")}>{l.sku.name}</div>
                    {l.flag?.unmapped && (
                      <Badge variant="danger" className="mt-0.5 gap-1 text-[10px]">
                        <AlertTriangle className="h-2.5 w-2.5" /> New SKU · not mapped
                      </Badge>
                    )}
                    {l.flag?.mismatch && (
                      <Badge variant="warning" className="mt-0.5 gap-1 text-[10px]" title={l.flag.reason}>
                        <AlertTriangle className="h-2.5 w-2.5" /> Price mismatch
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{l.rawData?.uom_text ?? l.sku.uom}</TableCell>
                  <TableCell className="text-right nums font-medium">{l.requestedQty}</TableCell>
                  <TableCell className="text-right nums">
                    {received != null ? received : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  {hasWarehouseData && (() => {
                    const entries = warehouseStock[l.skuId] ?? [];
                    // Judge availability at the shipping warehouse when known,
                    // otherwise against the total across warehouses.
                    const atDispatch = freeAtDispatch(l.skuId);
                    const available = atDispatch ?? entries.reduce((s, e) => s + e.freeQty, 0);
                    const qty = alloc[l.skuId] ?? 0;
                    const sufficient = available >= qty && qty > 0;
                    const tooltipLines = entries.length > 0
                      ? entries.map((e) => `${e.warehouseCode}: ${formatNumber(e.freeQty)} free`).join(" · ")
                      : "";
                    return (
                      <TableCell className="text-right nums" title={tooltipLines || undefined}>
                        {entries.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span
                            className={cn(
                              "font-medium",
                              available === 0 && "text-rose-600 dark:text-rose-400",
                              available > 0 && !sufficient && "text-amber-600 dark:text-amber-400",
                              sufficient && "text-emerald-600 dark:text-emerald-400",
                            )}
                          >
                            {formatNumber(available)}
                          </span>
                        )}
                      </TableCell>
                    );
                  })()}
                  <TableCell className="text-right">
                    <input
                      type="number"
                      min={0}
                      disabled={isRemoved || locked}
                      value={isRemoved ? "" : rawInputs[l.skuId] ?? ""}
                      onChange={(e) => set(l.skuId, e.target.value)}
                      onBlur={() =>
                        setRawInputs((p) => ({ ...p, [l.skuId]: String(alloc[l.skuId] ?? 0) }))
                      }
                      className={cn(
                        "h-9 w-24 rounded-lg border bg-card px-2 text-right text-sm nums outline-none focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:bg-muted/40",
                        tone,
                      )}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={locked}
                      className={cn("h-8 gap-1 px-2", isRemoved ? "text-muted-foreground" : "text-rose-600 hover:text-rose-700")}
                      onClick={() => toggleRemove(l.skuId)}
                      title={isRemoved ? "Restore this item" : "Remove this item from the allocation & email"}
                    >
                      {isRemoved ? <><Undo2 className="h-3.5 w-3.5" /> Restore</> : <Trash2 className="h-3.5 w-3.5" />}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => router.push("/allocate")} disabled={saving}>Cancel</Button>
        <Button
          onClick={() => hasTaxableMismatch && !confirmSend ? setConfirmSend(true) : save()}
          disabled={saving || totalAlloc === 0 || locked}
          className={hasTaxableMismatch && !confirmSend ? "gap-2 bg-amber-600 hover:bg-amber-700 text-white border-0" : "gap-2"}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : hasTaxableMismatch && !confirmSend ? <AlertTriangle className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
          {hasTaxableMismatch && !confirmSend ? "Price mismatch — click again to confirm send" : "Save allocation & send email"}
        </Button>
      </div>
    </div>
  );
}
