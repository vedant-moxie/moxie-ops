"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, ClipboardCheck, SendHorizonal } from "lucide-react";
import type { PoStatus } from "@prisma/client";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ChannelChip } from "@/components/shared/channel-chip";
import { StatusBadge } from "@/components/orders/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
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
}

export function AllocationList({ rows }: { rows: AllocRow[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter(
      (r) =>
        (r.channelPoNumber ?? "").toLowerCase().includes(s) ||
        (r.facility ?? "").toLowerCase().includes(s),
    );
  }, [rows, q]);

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

  async function bulkSend() {
    const poIds = Array.from(selected);
    if (poIds.length === 0) return;

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
      <div className="px-5 pb-3 pt-1 flex items-center gap-3">
        <Input
          placeholder="Search PO number or facility…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-9 max-w-xs"
        />
        {selectedCount > 0 && (
          <Button
            onClick={bulkSend}
            disabled={sending}
            className="gap-2 shrink-0"
          >
            <SendHorizonal className="h-4 w-4" />
            {sending && progress
              ? `Sending ${progress.done + 1}/${progress.total}…`
              : `Allocate full & send (${selectedCount})`}
          </Button>
        )}
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
            const progress = r.orderedUnits > 0 ? (r.allocatedUnits / r.orderedUnits) * 100 : 0;
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
                <TableCell className="font-medium">{r.channelPoNumber}</TableCell>
                <TableCell className="max-w-[200px] truncate text-muted-foreground">{r.facility ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(r.poDate)}</TableCell>
                <TableCell className="text-right nums">{r.skuCount}</TableCell>
                <TableCell className="text-right nums">{formatNumber(r.orderedUnits)}</TableCell>
                <TableCell className="text-right">
                  <span className={cn("nums font-medium", r.allocatedUnits > 0 ? "text-success" : "text-muted-foreground")}>
                    {formatNumber(r.allocatedUnits)}
                  </span>
                  {r.allocatedUnits > 0 && (
                    <span className="ml-1 text-[11px] text-muted-foreground">({Math.round(progress)}%)</span>
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
            onClick={bulkSend}
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
    </div>
  );
}
