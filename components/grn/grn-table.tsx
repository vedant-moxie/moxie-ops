"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ExternalLink } from "lucide-react";
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

export interface GrnRow {
  id: string;
  source: GrnSource;
  channelGrnNumber: string | null;
  status: GrnStatus;
  receivedAt: Date | string;
  totalAcceptedValue: number | null;
  po: { id: string; channelPoNumber: string | null; channel: { name: string; logoColor: string | null } };
  /** Deep link to the exact PO/GRN on the channel portal; null when unavailable. */
  portalUrl: string | null;
  _count: { lineItems: number };
  totalOrdered: number;
  totalReceived: number;
  fillRatePct: number;
  netFillPct: number | null;
  isPerfect: boolean;
  discrepancyCount: number;
  variances: Array<{ internalCode: string; name: string; ordered: number; received: number; variance: number }>;
}

/** Tiny "GRN" / "PO" tag so the identifier in the cell is always unambiguous. */
function IdTag({ kind }: { kind: "GRN" | "PO" }) {
  return (
    <span className="inline-flex items-center rounded bg-muted px-1 py-0 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
      {kind}
    </span>
  );
}

/**
 * Renders the PO number, deep-linking to the exact PO/GRN on the channel portal
 * when we have a URL for it (currently Nykaa). Plain text otherwise.
 */
function PortalLink({ url, channel, children }: { url: string | null; channel: string; children: React.ReactNode }) {
  if (!url) return <>{children}</>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open this PO/GRN on the ${channel} portal (requires portal login)`}
      className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
    >
      {children}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
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
  const [density] = useTableDensity("grn-table-density");
  const [channelSlug, setChannelSlug] = useState("all");
  const [status, setStatus] = useState("all");
  const [match, setMatch] = useState("all");
  const [search, setSearch] = useState("");
  const [receivedFrom, setReceivedFrom] = useState("");
  const [receivedTo, setReceivedTo] = useState("");

  const debouncedSearch = useDebounced(search);

  function clearFilters() {
    setChannelSlug("all");
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
        (status === "all" || g.status === status) &&
        (match === "all" ||
          (match === "perfect" ? g.isPerfect : !g.isPerfect)) &&
        (q === "" ||
          (g.channelGrnNumber ?? "").toLowerCase().includes(q) ||
          (g.po.channelPoNumber ?? "").toLowerCase().includes(q)) &&
        inDateRange(g.receivedAt, receivedFrom, receivedTo),
    );
  }, [grns, channelSlug, channelName, status, match, debouncedSearch, receivedFrom, receivedTo]);

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
          const meta = GRN_STATUS_META[grn.status];
          return (
            <TableRow key={grn.id}>
              <TableCell>
                <ChannelChip name={grn.po.channel.name} color={grn.po.channel.logoColor} />
              </TableCell>
              <TableCell>
                {grn.channelGrnNumber ? (
                  <>
                    <div className="flex items-center gap-1.5 font-medium">
                      <IdTag kind="GRN" /> {grn.channelGrnNumber}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      PO{" "}
                      <PortalLink url={grn.portalUrl} channel={grn.po.channel.name}>
                        {grn.po.channelPoNumber ?? "—"}
                      </PortalLink>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-1.5 font-medium">
                    <IdTag kind="PO" />{" "}
                    <PortalLink url={grn.portalUrl} channel={grn.po.channel.name}>
                      {grn.po.channelPoNumber ?? "—"}
                    </PortalLink>
                  </div>
                )}
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
                <div className="flex flex-col items-start gap-0.5">
                  <MatchBadge
                    isPerfect={grn.isPerfect}
                    fillRatePct={grn.fillRatePct}
                    variances={grn.variances}
                  />
                  <span className="text-[11px] text-muted-foreground nums">
                    Net {grn.netFillPct != null ? `${grn.netFillPct}%` : "—"}
                  </span>
                </div>
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
