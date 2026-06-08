"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, ClipboardCheck, SendHorizonal } from "lucide-react";
import type { PoStatus } from "@prisma/client";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectItem } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ChannelChip } from "@/components/shared/channel-chip";
import { StatusBadge } from "@/components/orders/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { SelectFilter, useDebounced } from "@/components/shared/table-filters";
import { PO_STATUS_META, PO_STATUS_ORDER } from "@/lib/status";
import { CHANNELS } from "@/lib/channels";
import { cn, formatINR, formatNumber, formatDate } from "@/lib/utils";

export interface AllocRow {
  id: string;
  channelPoNumber: string | null;
  status: PoStatus;
  poDate: Date | string | null;
  totalRequestedValue: number | null;
  channel: { name: string; logoColor: string | null };
  facility: string | null;
  skuCount: number;
  orderedUnits: number;
  allocatedUnits: number;
  hasTaxableMismatch: boolean;
  taxMismatchCount: number;
}

export function AllocationList({ rows }: { rows: AllocRow[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [channelSlug, setChannelSlug] = useState("all");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<string[] | null>(null);

  const debouncedQ = useDebounced(q);

  const filtersActive = q !== "" || channelSlug !== "all" || status !== "all";

  function clearFilters() {
    setQ("");
    setChannelSlug("all");
    setStatus("all");
  }

  const statusOptions = useMemo(() => {
    const present = new Set(rows.map((r) => r.status));
    return PO_STATUS_ORDER.filter((s) => present.has(s));
  }, [rows]);

  const filtered = useMemo(() => {
    const s = debouncedQ.trim().toLowerCase();
    const selectedChannel = CHANNELS.find((c) => c.slug === channelSlug);
    return rows.filter(
      (r) =>
        (s === "" ||
          (r.channelPoNumber ?? "").toLowerCase().includes(s) ||
          (r.facility ?? "").toLowerCase().includes(s)) &&
        (channelSlug === "all" || r.channel.name === selectedChannel?.name) &&
        (status === "all" || r.status === status),
    );
  }, [rows, debouncedQ, channelSlug, status]);

  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  const someFilteredSelected = filtered.some((r) => selected.has(r.id));

  function toggleAll() {
    if (allFilteredSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        filtered.forEach((r) => next.delete(r.id));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        filtered.forEach((r) => next.add(r.id));
        return next;
      });
    }
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function requestBulkSend() {
    const poIds = Array.from(selected);
    if (poIds.length === 0) return;
    const mismatched = poIds.filter((id) => rowById.get(id)?.hasTaxableMismatch);
    if (mismatched.length > 0) {
      setPendingConfirm(poIds);
    } else {
      void executeBulkSend(poIds);
    }
  }

  async function executeBulkSend(poIds: string[]) {
    setPendingConfirm(null);
    setSending(true);
    setProgress({ done: 0, total: poIds.length });

    try {
      const res = await fetch("/api/pos/allocate-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poIds }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? "Bulk allocation failed");

      const results: { poId: string; ok: boolean; error?: string }[] = json.data.results;
      const succeeded = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok).length;

      setProgress({ done: poIds.length, total: poIds.length });

      if (failed === 0) {
        toast.success(`Sent ${succeeded} PO${succeeded !== 1 ? "s" : ""}`);
      } else {
        toast.warning(`Sent ${succeeded} PO${succeeded !== 1 ? "s" : ""} · ${failed} failed`);
      }

      setSelected(new Set());
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk send failed");
    } finally {
      setSending(false);
      setProgress(null);
    }
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="Nothing to allocate"
        description="POs awaiting allocation appear here. Sync Blinkit to pull the latest."
      />
    );
  }

  const selectedCount = selected.size;

  return (
    <div>
      <div className="px-5 pb-3 pt-1 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search PO number or facility…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-9 w-[240px]"
        />
        <SelectFilter value={channelSlug} onChange={setChannelSlug} allLabel="All channels" width="w-[180px]">
          {CHANNELS.map((c) => (
            <SelectItem key={c.slug} value={c.slug}>
              <ChannelChip name={c.name} color={c.logoColor} />
            </SelectItem>
          ))}
        </SelectFilter>
        <SelectFilter value={status} onChange={setStatus} allLabel="All statuses">
          {statusOptions.map((s) => (
            <SelectItem key={s} value={s}>{PO_STATUS_META[s].label}</SelectItem>
          ))}
        </SelectFilter>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className="h-9 gap-1 text-muted-foreground"
          >
            <X className="h-3.5 w-3.5" /> Clear filters
          </Button>
        )}
        {selectedCount > 0 && (
          <Button
            onClick={requestBulkSend}
            disabled={sending}
            className="gap-2 shrink-0"
          >
            <SendHorizonal className="h-4 w-4" />
            {sending && progress
              ? `Sending ${progress.done + 1}/${progress.total}…`
              : `Allocate full & send (${selectedCount})`}
          </Button>
        )}
        <span className="ml-auto text-sm text-muted-foreground">
          {filtered.length === rows.length
            ? `${rows.length} PO${rows.length === 1 ? "" : "s"}`
            : `showing ${filtered.length} of ${rows.length} POs`}
        </span>
      </div>

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10">
              <Checkbox
                checked={allFilteredSelected}
                data-state={
                  allFilteredSelected
                    ? "checked"
                    : someFilteredSelected
                    ? "indeterminate"
                    : "unchecked"
                }
                onCheckedChange={toggleAll}
                aria-label="Select all filtered"
              />
            </TableHead>
            <TableHead>Channel</TableHead>
            <TableHead>PO Number</TableHead>
            <TableHead>Facility</TableHead>
            <TableHead>PO date</TableHead>
            <TableHead className="text-right">SKUs</TableHead>
            <TableHead className="text-right">Ordered</TableHead>
            <TableHead className="text-right">Allocated</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((r) => {
            const prog = r.orderedUnits > 0 ? (r.allocatedUnits / r.orderedUnits) * 100 : 0;
            const isSelected = selected.has(r.id);
            return (
              <TableRow key={r.id} className={cn("group", isSelected && "bg-muted/40")}>
                <TableCell>
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleRow(r.id)}
                    aria-label={`Select PO ${r.channelPoNumber ?? r.id}`}
                  />
                </TableCell>
                <TableCell><ChannelChip name={r.channel.name} color={r.channel.logoColor} /></TableCell>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-1.5">
                    {r.channelPoNumber}
                    {r.hasTaxableMismatch && (
                      <span
                        className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                        title={`${r.taxMismatchCount} line${r.taxMismatchCount !== 1 ? "s" : ""} have taxable value mismatch vs SKU master`}
                      >
                        <AlertTriangle className="h-2.5 w-2.5" />
                        Price
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="max-w-[200px] truncate text-muted-foreground">{r.facility ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(r.poDate)}</TableCell>
                <TableCell className="text-right nums">{r.skuCount}</TableCell>
                <TableCell className="text-right nums">{formatNumber(r.orderedUnits)}</TableCell>
                <TableCell className="text-right">
                  <span className={cn("nums font-medium", r.allocatedUnits > 0 ? "text-success" : "text-muted-foreground")}>
                    {formatNumber(r.allocatedUnits)}
                  </span>
                  {r.allocatedUnits > 0 && (
                    <span className="ml-1 text-[11px] text-muted-foreground">({Math.round(prog)}%)</span>
                  )}
                </TableCell>
                <TableCell><StatusBadge status={r.status} /></TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/allocate/${r.id}`}>
                      Open <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {/* Floating action bar — always visible when POs are selected */}
      {selectedCount > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 rounded-full border border-border/70 bg-card px-5 py-3 shadow-xl">
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {selectedCount} PO{selectedCount !== 1 ? "s" : ""} selected
          </span>
          <Button
            onClick={requestBulkSend}
            disabled={sending}
            className="gap-2 rounded-full"
          >
            <SendHorizonal className="h-4 w-4" />
            {sending && progress
              ? `Sending ${progress.done + 1}/${progress.total}…`
              : `Allocate full & send (${selectedCount})`}
          </Button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
            aria-label="Clear selection"
          >
            Clear
          </button>
        </div>
      )}

      {/* Taxable mismatch confirmation dialog */}
      {pendingConfirm && (
        <MismatchConfirmDialog
          poIds={pendingConfirm}
          rowById={rowById}
          onConfirm={() => executeBulkSend(pendingConfirm)}
          onCancel={() => setPendingConfirm(null)}
        />
      )}
    </div>
  );
}

function MismatchConfirmDialog({
  poIds,
  rowById,
  onConfirm,
  onCancel,
}: {
  poIds: string[];
  rowById: Map<string, AllocRow>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const mismatchedRows = poIds
    .map((id) => rowById.get(id))
    .filter((r): r is AllocRow => r?.hasTaxableMismatch === true);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            <h2 className="text-base font-semibold">Taxable value mismatch detected</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {mismatchedRows.length} of the {poIds.length} selected PO{poIds.length !== 1 ? "s" : ""} have line items
            where the channel-reported taxable value differs from the SKU master. Review before sending.
          </p>
        </div>
        <div className="max-h-64 overflow-y-auto px-5 py-3 space-y-2">
          {mismatchedRows.map((r) => (
            <div key={r.id} className="flex items-center justify-between text-sm rounded-md border border-amber-200 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20 px-3 py-2">
              <div>
                <span className="font-medium">{r.channelPoNumber ?? r.id}</span>
                <span className="ml-2 text-muted-foreground">{r.channel.name}</span>
              </div>
              <span className="text-amber-700 dark:text-amber-400 text-xs font-medium">
                {r.taxMismatchCount} line{r.taxMismatchCount !== 1 ? "s" : ""} differ
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
          <Button variant="outline" onClick={onCancel}>
            Cancel — go back
          </Button>
          <Button onClick={onConfirm} className="gap-2 bg-amber-600 hover:bg-amber-700 text-white border-0">
            <SendHorizonal className="h-4 w-4" />
            Send anyway ({poIds.length} PO{poIds.length !== 1 ? "s" : ""})
          </Button>
        </div>
      </div>
    </div>
  );
}
