"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Mail, Globe, FileSpreadsheet, CheckCircle2, ExternalLink } from "lucide-react";
import type { GrnSource, GrnStatus } from "@prisma/client";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { SelectItem } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ChannelChip } from "@/components/shared/channel-chip";
import { EmptyState } from "@/components/shared/empty-state";
import {
  FilterBar, FilterGroup, SearchFilter, SelectFilter,
  DateRangeFilter, useDebounced, inDateRange,
} from "@/components/shared/table-filters";
import { GRN_STATUS_META } from "@/lib/status";
import { CHANNELS } from "@/lib/channels";
import { formatINR, formatDate } from "@/lib/utils";

const SOURCE_META: Record<GrnSource, { label: string; icon: typeof Mail }> = {
  EMAIL: { label: "Email", icon: Mail },
  PORTAL: { label: "Portal", icon: Globe },
  MANUAL_CSV: { label: "CSV", icon: FileSpreadsheet },
};

export interface GrnRow {
  id: string;
  source: GrnSource;
  channelGrnNumber: string | null;
  status: GrnStatus;
  receivedAt: Date | string;
  totalAcceptedValue: number | null;
  po: { id: string; channelPoNumber: string | null; channel: { name: string; logoColor: string | null } };
  _count: { lineItems: number };
  totalOrdered: number;
  totalReceived: number;
  fillRatePct: number;
  isPerfect: boolean;
  discrepancyCount: number;
  variances: Array<{ internalCode: string; name: string; ordered: number; received: number; variance: number }>;
}

function MatchBadge({ isPerfect, fillRatePct, variances }: Pick<GrnRow, "isPerfect" | "fillRatePct" | "variances">) {
  if (isPerfect) {
    return <Badge variant="success">100% · Perfect</Badge>;
  }
  const shortCount = variances.filter((v) => v.variance < 0).length;
  const excessCount = variances.filter((v) => v.variance > 0).length;
  const label =
    shortCount > 0 && excessCount > 0
      ? `${fillRatePct}% · ${shortCount} short, ${excessCount} excess`
      : shortCount > 0
        ? `${fillRatePct}% · short ${shortCount}`
        : `${fillRatePct}% · excess ${excessCount}`;
  return <Badge variant={fillRatePct < 80 ? "danger" : "warning"}>{label}</Badge>;
}

export function GrnTable({ grns }: { grns: GrnRow[] }) {
  const [channelSlug, setChannelSlug] = useState("all");
  const [source, setSource] = useState("all");
  const [status, setStatus] = useState("all");
  const [match, setMatch] = useState("all");
  const [search, setSearch] = useState("");
  const [receivedFrom, setReceivedFrom] = useState("");
  const [receivedTo, setReceivedTo] = useState("");

  const debouncedSearch = useDebounced(search);

  const active =
    channelSlug !== "all" || source !== "all" || status !== "all" ||
    match !== "all" || search !== "" || receivedFrom !== "" || receivedTo !== "";

  function clearFilters() {
    setChannelSlug("all");
    setSource("all");
    setStatus("all");
    setMatch("all");
    setSearch("");
    setReceivedFrom("");
    setReceivedTo("");
  }

  const filtered = useMemo(() => {
    const selectedChannel = CHANNELS.find((c) => c.slug === channelSlug);
    const q = debouncedSearch.trim().toLowerCase();
    return grns.filter(
      (g) =>
        (channelSlug === "all" || g.po.channel.name === selectedChannel?.name) &&
        (source === "all" || g.source === source) &&
        (status === "all" || g.status === status) &&
        (match === "all" ||
          (match === "perfect" ? g.isPerfect : !g.isPerfect)) &&
        (q === "" ||
          (g.channelGrnNumber ?? "").toLowerCase().includes(q) ||
          (g.po.channelPoNumber ?? "").toLowerCase().includes(q)) &&
        inDateRange(g.receivedAt, receivedFrom, receivedTo),
    );
  }, [grns, channelSlug, source, status, match, debouncedSearch, receivedFrom, receivedTo]);

  if (grns.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        title="No GRNs yet"
        description="GRNs arrive via channel email, portal scrape, or manual CSV upload after delivery."
      />
    );
  }
  return (
    <div>
      <FilterBar
        active={active}
        onClear={clearFilters}
        count={filtered.length}
        total={grns.length}
        noun="GRNs"
      >
        <SelectFilter value={channelSlug} onChange={setChannelSlug} allLabel="All channels" width="w-[180px]">
          {CHANNELS.map((c) => (
            <SelectItem key={c.slug} value={c.slug}>
              <ChannelChip name={c.name} color={c.logoColor} />
            </SelectItem>
          ))}
        </SelectFilter>
        <SelectFilter value={source} onChange={setSource} allLabel="All sources" width="w-[150px]">
          {(Object.entries(SOURCE_META) as [GrnSource, (typeof SOURCE_META)[GrnSource]][]).map(
            ([k, v]) => (
              <SelectItem key={k} value={k}>{v.label}</SelectItem>
            ),
          )}
        </SelectFilter>
        <SelectFilter value={status} onChange={setStatus} allLabel="All statuses">
          {Object.entries(GRN_STATUS_META).map(([k, v]) => (
            <SelectItem key={k} value={k}>{v.label}</SelectItem>
          ))}
        </SelectFilter>
        <SelectFilter value={match} onChange={setMatch} allLabel="All matches" width="w-[170px]">
          <SelectItem value="perfect">Perfect</SelectItem>
          <SelectItem value="discrepancy">Has discrepancy</SelectItem>
        </SelectFilter>
        <SearchFilter value={search} onChange={setSearch} placeholder="GRN or PO number…" />
        <FilterGroup label="Received">
          <DateRangeFilter from={receivedFrom} to={receivedTo} onFrom={setReceivedFrom} onTo={setReceivedTo} />
        </FilterGroup>
      </FilterBar>

      {filtered.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="No GRNs match your filters"
          description="Adjust or clear the filters to see more results."
        />
      ) : (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Channel</TableHead>
          <TableHead>GRN / PO</TableHead>
          <TableHead>Source</TableHead>
          <TableHead className="text-right">Lines</TableHead>
          <TableHead className="text-right">Discrepancies</TableHead>
          <TableHead>Match</TableHead>
          <TableHead>Received</TableHead>
          <TableHead>Status</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {filtered.map((grn) => {
          const Src = SOURCE_META[grn.source];
          const meta = GRN_STATUS_META[grn.status];
          return (
            <TableRow key={grn.id}>
              <TableCell>
                <ChannelChip name={grn.po.channel.name} color={grn.po.channel.logoColor} />
              </TableCell>
              <TableCell>
                <div className="font-medium">{grn.channelGrnNumber ?? "—"}</div>
                <div className="text-xs text-muted-foreground">{grn.po.channelPoNumber}</div>
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Src.icon className="h-3.5 w-3.5" /> {Src.label}
                </span>
              </TableCell>
              <TableCell className="text-right nums text-muted-foreground">
                {grn._count.lineItems}
              </TableCell>
              <TableCell className="text-right nums">
                {grn.discrepancyCount > 0 ? (
                  <Badge variant="danger">{grn.discrepancyCount}</Badge>
                ) : (
                  <span className="text-muted-foreground">0</span>
                )}
              </TableCell>
              <TableCell>
                <MatchBadge
                  isPerfect={grn.isPerfect}
                  fillRatePct={grn.fillRatePct}
                  variances={grn.variances}
                />
              </TableCell>
              <TableCell className="text-muted-foreground">{formatDate(grn.receivedAt)}</TableCell>
              <TableCell><Badge variant={meta.variant}>{meta.label}</Badge></TableCell>
              <TableCell>
                <Link
                  href={`/orders/${grn.po.id}#grn`}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  {grn.isPerfect ? "View breakdown" : "View discrepancies"}
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
      )}
    </div>
  );
}
