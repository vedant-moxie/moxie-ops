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
import { ColumnFilter } from "@/components/shared/column-filter";
import {
  TableToolbar, useTableDensity, densityClass, type FilterChipDef,
} from "@/components/shared/table-toolbar";
import {
  SearchFilter, SelectFilter, DateRangeFilter, useDebounced, inDateRange,
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

const MATCH_LABEL: Record<string, string> = {
  perfect: "Perfect",
  discrepancy: "Has discrepancy",
};

export function GrnTable({ grns }: { grns: GrnRow[] }) {
  const [density, setDensity] = useTableDensity("grn-table-density");
  const [channelSlug, setChannelSlug] = useState("all");
  const [source, setSource] = useState("all");
  const [status, setStatus] = useState("all");
  const [match, setMatch] = useState("all");
  const [search, setSearch] = useState("");
  const [receivedFrom, setReceivedFrom] = useState("");
  const [receivedTo, setReceivedTo] = useState("");

  const debouncedSearch = useDebounced(search);

  function clearFilters() {
    setChannelSlug("all");
    setSource("all");
    setStatus("all");
    setMatch("all");
    setSearch("");
    setReceivedFrom("");
    setReceivedTo("");
  }

  const channelName = CHANNELS.find((c) => c.slug === channelSlug)?.name;
  const chips: FilterChipDef[] = [];
  if (channelSlug !== "all")
    chips.push({ key: "channel", label: channelName ?? channelSlug, onRemove: () => setChannelSlug("all") });
  if (search !== "")
    chips.push({ key: "search", label: `Search: ${search}`, onRemove: () => setSearch("") });
  if (source !== "all")
    chips.push({ key: "source", label: SOURCE_META[source as GrnSource]?.label ?? source, onRemove: () => setSource("all") });
  if (match !== "all")
    chips.push({ key: "match", label: MATCH_LABEL[match] ?? match, onRemove: () => setMatch("all") });
  if (receivedFrom !== "" || receivedTo !== "")
    chips.push({ key: "received", label: `Received ${receivedFrom || "…"}–${receivedTo || "…"}`, onRemove: () => { setReceivedFrom(""); setReceivedTo(""); } });
  if (status !== "all")
    chips.push({ key: "status", label: GRN_STATUS_META[status as GrnStatus]?.label ?? status, onRemove: () => setStatus("all") });

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return grns.filter(
      (g) =>
        (channelSlug === "all" || g.po.channel.name === channelName) &&
        (source === "all" || g.source === source) &&
        (status === "all" || g.status === status) &&
        (match === "all" ||
          (match === "perfect" ? g.isPerfect : !g.isPerfect)) &&
        (q === "" ||
          (g.channelGrnNumber ?? "").toLowerCase().includes(q) ||
          (g.po.channelPoNumber ?? "").toLowerCase().includes(q)) &&
        inDateRange(g.receivedAt, receivedFrom, receivedTo),
    );
  }, [grns, channelSlug, channelName, source, status, match, debouncedSearch, receivedFrom, receivedTo]);

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
      <TableToolbar
        density={density}
        onDensityChange={setDensity}
        chips={chips}
        onClearAll={clearFilters}
        count={filtered.length}
        total={grns.length}
        noun="GRNs"
      />

      {filtered.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="No GRNs match your filters"
          description="Adjust or clear the filters to see more results."
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
            <ColumnFilter label="GRN / PO" active={search !== ""} onClear={() => setSearch("")}>
              <SearchFilter value={search} onChange={setSearch} placeholder="GRN or PO number…" className="w-full" />
            </ColumnFilter>
          </TableHead>
          <TableHead>
            <ColumnFilter label="Source" active={source !== "all"} onClear={() => setSource("all")}>
              <SelectFilter value={source} onChange={setSource} allLabel="All sources" width="w-full">
                {(Object.entries(SOURCE_META) as [GrnSource, (typeof SOURCE_META)[GrnSource]][]).map(
                  ([k, v]) => (
                    <SelectItem key={k} value={k}>{v.label}</SelectItem>
                  ),
                )}
              </SelectFilter>
            </ColumnFilter>
          </TableHead>
          <TableHead className="text-right">Lines</TableHead>
          <TableHead className="text-right">Discrepancies</TableHead>
          <TableHead>
            <ColumnFilter label="Match" active={match !== "all"} onClear={() => setMatch("all")}>
              <SelectFilter value={match} onChange={setMatch} allLabel="All matches" width="w-full">
                <SelectItem value="perfect">Perfect</SelectItem>
                <SelectItem value="discrepancy">Has discrepancy</SelectItem>
              </SelectFilter>
            </ColumnFilter>
          </TableHead>
          <TableHead>
            <ColumnFilter label="Received" active={receivedFrom !== "" || receivedTo !== ""} onClear={() => { setReceivedFrom(""); setReceivedTo(""); }}>
              <DateRangeFilter from={receivedFrom} to={receivedTo} onFrom={setReceivedFrom} onTo={setReceivedTo} />
            </ColumnFilter>
          </TableHead>
          <TableHead>
            <ColumnFilter label="Status" active={status !== "all"} onClear={() => setStatus("all")}>
              <SelectFilter value={status} onChange={setStatus} allLabel="All statuses" width="w-full">
                {Object.entries(GRN_STATUS_META).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v.label}</SelectItem>
                ))}
              </SelectFilter>
            </ColumnFilter>
          </TableHead>
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
