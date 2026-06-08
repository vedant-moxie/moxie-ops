"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Inbox } from "lucide-react";
import type { PoStatus } from "@prisma/client";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { SelectItem } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ChannelChip } from "@/components/shared/channel-chip";
import { StatusBadge } from "@/components/orders/status-badge";
import { PriorityBadge } from "@/components/dashboard/priority-badge";
import { EmptyState } from "@/components/shared/empty-state";
import {
  FilterBar, FilterGroup, SearchFilter, SelectFilter,
  NumberRangeFilter, DateRangeFilter, useDebounced, inNumberRange, inDateRange,
} from "@/components/shared/table-filters";
import { PO_STATUS_META, PRIORITY_META } from "@/lib/status";
import { formatINR, formatDate } from "@/lib/utils";
import { CHANNELS } from "@/lib/channels";

export interface PoRow {
  id: string;
  channelPoNumber: string | null;
  status: PoStatus;
  priority: string | null;
  priorityScore: number | null;
  totalRequestedValue: number | null;
  requestedDeliveryDate: Date | string | null;
  poDate: Date | string | null;
  createdAt: Date | string;
  channel: { id: string; name: string; logoColor: string | null; tier: string };
  _count: { lineItems: number };
}

export function PoTable({
  pos,
  showAllocateCta = false,
}: {
  pos: PoRow[];
  showAllocateCta?: boolean;
}) {
  const [channelSlug, setChannelSlug] = useState("all");
  const [status, setStatus] = useState("all");
  const [priority, setPriority] = useState("all");
  const [poNumber, setPoNumber] = useState("");
  const [valueMin, setValueMin] = useState("");
  const [valueMax, setValueMax] = useState("");
  const [deliveryFrom, setDeliveryFrom] = useState("");
  const [deliveryTo, setDeliveryTo] = useState("");
  const [poDateFrom, setPoDateFrom] = useState("");
  const [poDateTo, setPoDateTo] = useState("");

  const debouncedPoNumber = useDebounced(poNumber);

  const active =
    channelSlug !== "all" || status !== "all" || priority !== "all" ||
    poNumber !== "" || valueMin !== "" || valueMax !== "" ||
    deliveryFrom !== "" || deliveryTo !== "" || poDateFrom !== "" || poDateTo !== "";

  function clearFilters() {
    setChannelSlug("all");
    setStatus("all");
    setPriority("all");
    setPoNumber("");
    setValueMin("");
    setValueMax("");
    setDeliveryFrom("");
    setDeliveryTo("");
    setPoDateFrom("");
    setPoDateTo("");
  }

  const filtered = useMemo(() => {
    const selectedChannel = CHANNELS.find((c) => c.slug === channelSlug);
    const q = debouncedPoNumber.trim().toLowerCase();
    return pos.filter(
      (p) =>
        (channelSlug === "all" || p.channel.name === selectedChannel?.name) &&
        (status === "all" || p.status === status) &&
        (priority === "all" || p.priority === priority) &&
        (q === "" || (p.channelPoNumber ?? "").toLowerCase().includes(q)) &&
        inNumberRange(p.totalRequestedValue, valueMin, valueMax) &&
        inDateRange(p.requestedDeliveryDate, deliveryFrom, deliveryTo) &&
        inDateRange(p.poDate, poDateFrom, poDateTo),
    );
  }, [
    pos, channelSlug, status, priority, debouncedPoNumber,
    valueMin, valueMax, deliveryFrom, deliveryTo, poDateFrom, poDateTo,
  ]);

  return (
    <div>
      <FilterBar
        active={active}
        onClear={clearFilters}
        count={filtered.length}
        total={pos.length}
        noun="orders"
      >
        <SelectFilter value={channelSlug} onChange={setChannelSlug} allLabel="All channels" width="w-[200px]">
          {CHANNELS.map((c) => (
            <SelectItem key={c.slug} value={c.slug}>
              <ChannelChip name={c.name} color={c.logoColor} />
            </SelectItem>
          ))}
        </SelectFilter>
        <SelectFilter value={status} onChange={setStatus} allLabel="All statuses">
          {Object.entries(PO_STATUS_META).map(([k, v]) => (
            <SelectItem key={k} value={k}>{v.label}</SelectItem>
          ))}
        </SelectFilter>
        <SelectFilter value={priority} onChange={setPriority} allLabel="All priorities" width="w-[150px]">
          {Object.entries(PRIORITY_META).map(([k, v]) => (
            <SelectItem key={k} value={k}>{v.label}</SelectItem>
          ))}
        </SelectFilter>
        <SearchFilter value={poNumber} onChange={setPoNumber} placeholder="PO number…" />
        <FilterGroup label="Value">
          <NumberRangeFilter min={valueMin} max={valueMax} onMin={setValueMin} onMax={setValueMax} />
        </FilterGroup>
        <FilterGroup label="Delivery">
          <DateRangeFilter from={deliveryFrom} to={deliveryTo} onFrom={setDeliveryFrom} onTo={setDeliveryTo} />
        </FilterGroup>
        <FilterGroup label="PO date">
          <DateRangeFilter from={poDateFrom} to={poDateTo} onFrom={setPoDateFrom} onTo={setPoDateTo} />
        </FilterGroup>
      </FilterBar>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No POs to show"
          description="The Gmail poller checks for new purchase orders every 10 minutes."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Channel</TableHead>
              <TableHead>PO Number</TableHead>
              <TableHead className="text-right">Value</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead className="text-right">SKUs</TableHead>
              <TableHead>Delivery</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((po) => (
              <TableRow key={po.id} className="group">
                <TableCell>
                  <ChannelChip name={po.channel.name} color={po.channel.logoColor} tier={po.channel.tier} />
                </TableCell>
                <TableCell>
                  <Link href={`/orders/${po.id}`} className="font-medium hover:underline">
                    {po.channelPoNumber ?? "—"}
                  </Link>
                </TableCell>
                <TableCell className="text-right font-medium nums">
                  {formatINR(po.totalRequestedValue)}
                </TableCell>
                <TableCell>
                  <PriorityBadge poId={po.id} priority={po.priority} />
                </TableCell>
                <TableCell className="text-right nums text-muted-foreground">
                  {po._count.lineItems}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(po.requestedDeliveryDate)}
                </TableCell>
                <TableCell>
                  <StatusBadge status={po.status} />
                </TableCell>
                <TableCell className="text-right">
                  <Link
                    href={`/orders/${po.id}`}
                    className="inline-flex items-center gap-1 text-sm text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    View <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {showAllocateCta && filtered.length > 0 && (
        <div className="flex justify-end border-t border-border/60 px-5 py-4">
          <Button asChild>
            <Link href="/allocate">
              Go to allocation <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
