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
import { ColumnFilter } from "@/components/shared/column-filter";
import {
  TableToolbar, useTableDensity, densityClass, type FilterChipDef,
} from "@/components/shared/table-toolbar";
import {
  SearchFilter, SelectFilter, NumberRangeFilter, DateRangeFilter,
  useDebounced, inNumberRange, inDateRange,
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
  const [density, setDensity] = useTableDensity("po-table-density");
  const [channelSlug, setChannelSlug] = useState("all");
  const [status, setStatus] = useState("all");
  const [priority, setPriority] = useState("all");
  const [poNumber, setPoNumber] = useState("");
  const [valueMin, setValueMin] = useState("");
  const [valueMax, setValueMax] = useState("");
  const [deliveryFrom, setDeliveryFrom] = useState("");
  const [deliveryTo, setDeliveryTo] = useState("");

  const debouncedPoNumber = useDebounced(poNumber);

  function clearFilters() {
    setChannelSlug("all");
    setStatus("all");
    setPriority("all");
    setPoNumber("");
    setValueMin("");
    setValueMax("");
    setDeliveryFrom("");
    setDeliveryTo("");
  }

  const channelName = CHANNELS.find((c) => c.slug === channelSlug)?.name;
  const chips: FilterChipDef[] = [];
  if (channelSlug !== "all")
    chips.push({ key: "channel", label: channelName ?? channelSlug, onRemove: () => setChannelSlug("all") });
  if (poNumber !== "")
    chips.push({ key: "po", label: `PO: ${poNumber}`, onRemove: () => setPoNumber("") });
  if (valueMin !== "" || valueMax !== "")
    chips.push({ key: "value", label: `Value ${valueMin || "0"}–${valueMax || "∞"}`, onRemove: () => { setValueMin(""); setValueMax(""); } });
  if (priority !== "all")
    chips.push({ key: "priority", label: PRIORITY_META[priority]?.label ?? priority, onRemove: () => setPriority("all") });
  if (deliveryFrom !== "" || deliveryTo !== "")
    chips.push({ key: "delivery", label: `Delivery ${deliveryFrom || "…"}–${deliveryTo || "…"}`, onRemove: () => { setDeliveryFrom(""); setDeliveryTo(""); } });
  if (status !== "all")
    chips.push({ key: "status", label: PO_STATUS_META[status as PoStatus]?.label ?? status, onRemove: () => setStatus("all") });

  const filtered = useMemo(() => {
    const q = debouncedPoNumber.trim().toLowerCase();
    return pos.filter(
      (p) =>
        (channelSlug === "all" || p.channel.name === channelName) &&
        (status === "all" || p.status === status) &&
        (priority === "all" || p.priority === priority) &&
        (q === "" || (p.channelPoNumber ?? "").toLowerCase().includes(q)) &&
        inNumberRange(p.totalRequestedValue, valueMin, valueMax) &&
        inDateRange(p.requestedDeliveryDate, deliveryFrom, deliveryTo),
    );
  }, [
    pos, channelSlug, channelName, status, priority, debouncedPoNumber,
    valueMin, valueMax, deliveryFrom, deliveryTo,
  ]);

  return (
    <div>
      <TableToolbar
        density={density}
        onDensityChange={setDensity}
        chips={chips}
        onClearAll={clearFilters}
        count={filtered.length}
        total={pos.length}
        noun="orders"
      />

      {filtered.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No POs to show"
          description="The Gmail poller checks for new purchase orders every 10 minutes."
        />
      ) : (
        <Table className={densityClass(density)}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>
                <ColumnFilter label="Channel" active={channelSlug !== "all"} onClear={() => setChannelSlug("all")}>
                  <SelectFilter value={channelSlug} onChange={setChannelSlug} allLabel="All channels" width="w-full">
                    {CHANNELS.map((c) => (
                      <SelectItem key={c.slug} value={c.slug}>
                        <ChannelChip name={c.name} color={c.logoColor} />
                      </SelectItem>
                    ))}
                  </SelectFilter>
                </ColumnFilter>
              </TableHead>
              <TableHead>
                <ColumnFilter label="PO Number" active={poNumber !== ""} onClear={() => setPoNumber("")}>
                  <SearchFilter value={poNumber} onChange={setPoNumber} placeholder="PO number…" className="w-full" />
                </ColumnFilter>
              </TableHead>
              <TableHead className="text-right">
                <ColumnFilter label="Value" align="right" active={valueMin !== "" || valueMax !== ""} onClear={() => { setValueMin(""); setValueMax(""); }}>
                  <NumberRangeFilter min={valueMin} max={valueMax} onMin={setValueMin} onMax={setValueMax} />
                </ColumnFilter>
              </TableHead>
              <TableHead>
                <ColumnFilter label="Priority" active={priority !== "all"} onClear={() => setPriority("all")}>
                  <SelectFilter value={priority} onChange={setPriority} allLabel="All priorities" width="w-full">
                    {Object.entries(PRIORITY_META).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v.label}</SelectItem>
                    ))}
                  </SelectFilter>
                </ColumnFilter>
              </TableHead>
              <TableHead className="text-right">SKUs</TableHead>
              <TableHead>
                <ColumnFilter label="Delivery" active={deliveryFrom !== "" || deliveryTo !== ""} onClear={() => { setDeliveryFrom(""); setDeliveryTo(""); }}>
                  <DateRangeFilter from={deliveryFrom} to={deliveryTo} onFrom={setDeliveryFrom} onTo={setDeliveryTo} />
                </ColumnFilter>
              </TableHead>
              <TableHead>
                <ColumnFilter label="Status" active={status !== "all"} onClear={() => setStatus("all")}>
                  <SelectFilter value={status} onChange={setStatus} allLabel="All statuses" width="w-full">
                    {Object.entries(PO_STATUS_META).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v.label}</SelectItem>
                    ))}
                  </SelectFilter>
                </ColumnFilter>
              </TableHead>
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
