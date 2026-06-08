"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Inbox } from "lucide-react";
import type { PoStatus } from "@prisma/client";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ChannelChip } from "@/components/shared/channel-chip";
import { StatusBadge } from "@/components/orders/status-badge";
import { PriorityBadge } from "@/components/dashboard/priority-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { PO_STATUS_META } from "@/lib/status";
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
  const [channelSlug, setChannelSlug] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");

  const filtered = useMemo(() => {
    const selectedChannel = CHANNELS.find((c) => c.slug === channelSlug);
    return pos.filter(
      (p) =>
        (channelSlug === "all" || p.channel.name === selectedChannel?.name) &&
        (status === "all" || p.status === status),
    );
  }, [pos, channelSlug, status]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 px-5 pb-3 pt-1">
        <Select value={channelSlug} onValueChange={setChannelSlug}>
          <SelectTrigger className="h-9 w-[200px]">
            <SelectValue placeholder="All channels" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All channels</SelectItem>
            {CHANNELS.map((c) => (
              <SelectItem key={c.slug} value={c.slug}>
                <ChannelChip name={c.name} color={c.logoColor} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-9 w-[170px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {Object.entries(PO_STATUS_META).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-sm text-muted-foreground">
          {filtered.length} order{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

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
