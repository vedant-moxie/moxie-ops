"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  Bar, BarChart, Area, AreaChart, Pie, PieChart, Cell,
  ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import {
  Package, IndianRupee, Boxes, Store, RefreshCw, Upload, ChevronDown,
  ChevronRight, FileSpreadsheet, Loader2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { StatCard } from "@/components/dashboard/summary-stats";
import { EmptyState } from "@/components/shared/empty-state";
import { cn, formatINR, formatNumber, formatDate, relativeTime } from "@/lib/utils";
import type { ChannelConfig } from "@/lib/channels";
import type { ChannelInsights } from "@/lib/services/blinkit-analytics";

const LIME = "#a3d83b";
const MINT = "#7fd9b8";
const COLORS = ["#a3d83b", "#7fd9b8", "#f6c344", "#7c6df0", "#ef7d7d", "#5cb8e4", "#c0a3e8"];
const tooltipStyle = { borderRadius: 12, border: "1px solid #e7e2d4", fontSize: 12 };
const axis = { fontSize: 11, fill: "#9a958a" };
const shortDate = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });

export function ChannelDashboard({
  channel,
  insights,
  days,
}: {
  channel: ChannelConfig;
  insights: ChannelInsights;
  days: number;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  function setDays(d: number) {
    startTransition(() => router.push(`/channels/${channel.slug}?days=${d}`));
  }

  async function liveSync() {
    setBusy("scan");
    const t = toast.loading(`Syncing ${channel.name} POs…`);
    try {
      const res = await fetch(`/api/${channel.slug}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      // The API always replies with a JSON envelope ({ success, data | error }),
      // including for handled failures (HTTP 500 with json.error). Surface that
      // real, per-channel reason in the toast. Only a genuinely non-JSON reply
      // (e.g. an HTML 404 for a route not present on this deploy) is treated as
      // "not wired up yet".
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        throw new Error("__unavailable__");
      }
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Sync failed");
      const s = json.data.summary;
      toast.success(
        `Synced ${s.posUpserted} PO(s), ${s.lineItems} lines (${json.data.since} → ${json.data.until})`,
        { id: t },
      );
      router.refresh();
    } catch (e) {
      const msg =
        e instanceof Error && e.message !== "__unavailable__"
          ? e.message
          : "Sync not available yet";
      toast.error(msg, { id: t });
    } finally {
      setBusy(null);
    }
  }

  async function uploadFile(file: File) {
    setBusy("upload");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/${channel.slug}/import`, { method: "POST", body: fd });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      const s = json.data.summaries[0];
      toast.success(`Imported ${s.posUpserted} PO(s), ${s.lineItems} lines from ${file.name}`);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-full bg-muted p-1">
        {[7, 14, 30].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
              days === d ? "bg-card text-foreground shadow-soft" : "text-muted-foreground",
            )}
          >
            {d}d
          </button>
        ))}
      </div>
      {channel.hasUpload && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); }}
          />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={!!busy}>
            {busy === "upload" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Upload dump
          </Button>
        </>
      )}
      <Button size="sm" onClick={liveSync} disabled={!!busy}>
        {busy === "scan" || pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        Sync from {channel.name}
      </Button>
    </div>
  );

  if (!insights.hasData) {
    return (
      <div className="space-y-4">
        <div className="flex justify-end">{controls}</div>
        <Card>
          <EmptyState
            icon={FileSpreadsheet}
            title={`No ${channel.name} POs in the last ${days} days`}
            description={
              channel.hasUpload
                ? `Click Sync from ${channel.name} to scrape live (backfills from June 1). You can also upload a dump file directly.`
                : `Click Sync from ${channel.name} to pull purchase orders once the integration is wired up.`
            }
            action={
              <Button onClick={liveSync} disabled={!!busy}>
                <RefreshCw className="h-4 w-4" /> Sync from {channel.name}
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const s = insights.summary;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {s.poCount} POs · {formatNumber(s.lineCount)} line items · last {days} days
          {insights.lastSyncedAt && (
            <>
              {" · "}
              <span className="inline-flex items-center gap-1 text-success">
                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                auto-syncs every {insights.intervalHours}h · last {relativeTime(insights.lastSyncedAt)}
              </span>
            </>
          )}
        </p>
        {controls}
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-5">
        <StatCard label="Purchase orders" value={formatNumber(s.poCount)} icon={Package} accent="lime" />
        <StatCard label="Order value" value={formatINR(s.totalValue)} icon={IndianRupee} accent="mint" />
        <StatCard label="Total units" value={formatNumber(s.totalUnits)} icon={Boxes} accent="lav" />
        <StatCard label="Distinct items" value={formatNumber(s.distinctItems)} icon={Boxes} accent="lav" />
        <StatCard label="Outlets" value={formatNumber(s.distinctOutlets)} icon={Store} accent="lav" />
      </div>

      <Tabs defaultValue="pos">
        <TabsList>
          <TabsTrigger value="pos">Purchase orders</TabsTrigger>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="items">By item</TabsTrigger>
          <TabsTrigger value="outlets">By outlet</TabsTrigger>
          <TabsTrigger value="fields">Fields</TabsTrigger>
        </TabsList>

        <TabsContent value="pos">
          <Card className="overflow-hidden">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">POs — last {days} days (all fields)</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <PoTable rows={insights.pos} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="overview">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Order value by day</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={insights.byDay} margin={{ left: -8 }}>
                    <defs>
                      <linearGradient id="bval" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={LIME} stopOpacity={0.7} />
                        <stop offset="100%" stopColor={LIME} stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eee7d6" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={shortDate} tick={axis} axisLine={false} tickLine={false} minTickGap={24} />
                    <YAxis tick={axis} axisLine={false} tickLine={false} width={64} tickFormatter={(v) => `₹${Math.round(v / 1000)}k`} />
                    <Tooltip contentStyle={tooltipStyle} labelFormatter={shortDate} formatter={(v: number) => [formatINR(v), "Value"]} />
                    <Area type="monotone" dataKey="value" stroke={LIME} strokeWidth={2} fill="url(#bval)" />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Units & POs by day</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={insights.byDay} margin={{ left: -16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eee7d6" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={shortDate} tick={axis} axisLine={false} tickLine={false} minTickGap={24} />
                    <YAxis tick={axis} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={tooltipStyle} labelFormatter={shortDate} />
                    <Bar dataKey="units" fill={MINT} radius={[6, 6, 0, 0]} maxBarSize={36} name="Units" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader><CardTitle className="text-base">PO status mix (raw {channel.name} status)</CardTitle></CardHeader>
              <CardContent className="flex flex-col items-center gap-6 sm:flex-row">
                <ResponsiveContainer width="100%" height={220} className="max-w-[280px]">
                  <PieChart>
                    <Pie data={insights.byStatus} dataKey="count" nameKey="status" innerRadius={56} outerRadius={88} paddingAngle={2}>
                      {insights.byStatus.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={tooltipStyle} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex flex-wrap gap-3">
                  {insights.byStatus.map((st, i) => (
                    <span key={st.status} className="flex items-center gap-1.5 text-sm">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                      {st.status} <span className="font-semibold nums">{st.count}</span>
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="items">
          <Card>
            <CardHeader><CardTitle className="text-base">Top items by value</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={Math.max(220, insights.topItems.length * 34)}>
                <BarChart layout="vertical" data={insights.topItems} margin={{ left: 8, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee7d6" horizontal={false} />
                  <XAxis type="number" tick={axis} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${Math.round(v / 1000)}k`} />
                  <YAxis type="category" dataKey="code" tick={{ fontSize: 11, fill: "#6b6b60" }} axisLine={false} tickLine={false} width={110} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [formatINR(v), "Value"]} />
                  <Bar dataKey="value" fill={LIME} radius={[0, 6, 6, 0]} maxBarSize={22} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
          <Card className="mt-4 overflow-hidden">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">POs</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {insights.topItems.map((it) => (
                    <TableRow key={it.code}>
                      <TableCell>
                        <div className="font-medium">{it.code}</div>
                        <div className="text-xs text-muted-foreground">{it.name}</div>
                      </TableCell>
                      <TableCell className="text-right nums">{it.pos}</TableCell>
                      <TableCell className="text-right nums">{formatNumber(it.units)}</TableCell>
                      <TableCell className="text-right nums font-medium">{formatINR(it.value)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="outlets">
          <Card className="overflow-hidden">
            <CardHeader><CardTitle className="text-base">By outlet / destination</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Outlet</TableHead>
                    <TableHead className="text-right">POs</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {insights.byOutlet.map((o) => (
                    <TableRow key={o.outlet}>
                      <TableCell className="font-medium">{o.outlet}</TableCell>
                      <TableCell className="text-right nums">{o.pos}</TableCell>
                      <TableCell className="text-right nums">{formatNumber(o.units)}</TableCell>
                      <TableCell className="text-right nums font-medium">{formatINR(o.value)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="fields">
          <Card>
            <CardHeader><CardTitle className="text-base">Source columns ({insights.headers.length})</CardTitle></CardHeader>
            <CardContent>
              <p className="mb-3 text-sm text-muted-foreground">
                Every column from the dump is preserved on each PO. These are the raw headers found:
              </p>
              <div className="flex flex-wrap gap-2">
                {insights.headers.map((h) => (
                  <Badge key={h} variant="outline" className="font-mono text-[11px]">{h}</Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PoTable({ rows }: { rows: ChannelInsights["pos"] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  function toggle(id: string) {
    setOpen((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-8" />
          <TableHead>PO Number</TableHead>
          <TableHead>PO Date</TableHead>
          <TableHead>Outlet</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Lines</TableHead>
          <TableHead className="text-right">Units</TableHead>
          <TableHead className="text-right">Value</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((po) => {
          const isOpen = open.has(po.id);
          return (
            <>
              <TableRow key={po.id} className="cursor-pointer" onClick={() => toggle(po.id)}>
                <TableCell>
                  {isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                </TableCell>
                <TableCell>
                  <Link href={`/orders/${po.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">
                    {po.poNumber}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDate(po.poDate)}</TableCell>
                <TableCell>{po.outlet ?? po.city ?? "—"}</TableCell>
                <TableCell>{po.rawStatus ? <Badge variant="outline">{po.rawStatus}</Badge> : "—"}</TableCell>
                <TableCell className="text-right nums">{po.lineCount}</TableCell>
                <TableCell className="text-right nums">{formatNumber(po.units)}</TableCell>
                <TableCell className="text-right nums font-medium">{formatINR(po.value)}</TableCell>
              </TableRow>
              {isOpen && (
                <TableRow key={po.id + "-items"} className="hover:bg-transparent">
                  <TableCell colSpan={8} className="bg-muted/30 p-0">
                    <div className="p-3">
                      <div className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        SKUs ordered · {po.items.length}
                      </div>
                      <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border/60 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                              <th className="px-3 py-2">Item ID</th>
                              <th className="px-3 py-2">UPC</th>
                              <th className="px-3 py-2">Product</th>
                              <th className="px-3 py-2">UOM</th>
                              <th className="px-3 py-2 text-right">Ordered</th>
                              <th className="px-3 py-2 text-right">Received</th>
                              <th className="px-3 py-2 text-right">Rate</th>
                              <th className="px-3 py-2 text-right">Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {po.items.map((it, i) => (
                              <tr key={it.itemId + i} className="border-b border-border/40 last:border-0">
                                <td className="px-3 py-2 font-mono text-xs">{it.itemId}</td>
                                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{it.upc ?? "—"}</td>
                                <td className="max-w-[280px] px-3 py-2"><div className="truncate">{it.name}</div></td>
                                <td className="px-3 py-2 text-muted-foreground">{it.uom ?? "—"}</td>
                                <td className="px-3 py-2 text-right nums font-medium">{formatNumber(it.ordered)}</td>
                                <td className="px-3 py-2 text-right nums">
                                  {it.received != null ? formatNumber(it.received) : <span className="text-muted-foreground">—</span>}
                                </td>
                                <td className="px-3 py-2 text-right nums text-muted-foreground">{it.unitPrice != null ? formatINR(it.unitPrice) : "—"}</td>
                                <td className="px-3 py-2 text-right nums">{it.value != null ? formatINR(it.value) : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </>
          );
        })}
      </TableBody>
    </Table>
  );
}
