"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ClipboardCheck, Loader2 } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChannelChip } from "@/components/shared/channel-chip";
import { EmptyState } from "@/components/shared/empty-state";
import { SO_CHECK_META } from "@/lib/status";
import type { SoCheckRow } from "@/lib/data/queries";
import { cn, formatDate, formatDateTime, formatINR, formatNumber } from "@/lib/utils";

export function SoCheckTable({ rows }: { rows: SoCheckRow[] }) {
  const router = useRouter();
  const [openPo, setOpenPo] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="No approved POs in this window"
        description="Once a PO is approved and the warehouse team punches its sales order into the WMS, the quantity check lands here."
      />
    );
  }

  const active = rows.find((r) => r.poId === openPo) ?? null;

  async function resolve(poId: string, action: "resolve" | "reopen") {
    setBusy(true);
    try {
      const res = await fetch(`/api/so-checks/${poId}/resolve`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note: note || undefined }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast.success(action === "resolve" ? "Flag resolved" : "Flag reopened");
      setNote("");
      setOpenPo(null);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Channel</TableHead>
            <TableHead>Channel PO</TableHead>
            <TableHead>MB ref</TableHead>
            <TableHead>Party</TableHead>
            <TableHead>Approved</TableHead>
            <TableHead>WH</TableHead>
            <TableHead className="text-center">SKUs</TableHead>
            <TableHead className="text-right">Ours vs WMS SO</TableHead>
            <TableHead>Flag</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const meta = r.result ? SO_CHECK_META[r.result] : null;
            // On a header-only read path the WMS quantity is unknown, not zero — showing
            // "0" would read as "nothing was punched", which is a different problem.
            const qtyUnknown = r.result === "QTY_UNVERIFIED";
            const off = !qtyUnknown && r.wmsQty != null && r.wmsQty !== r.ourQty;
            return (
              <TableRow
                key={r.poId}
                onClick={() => setOpenPo(r.poId)}
                className={cn("cursor-pointer", r.resolvedAt && "opacity-60")}
              >
                <TableCell>
                  <ChannelChip name={r.channel.name} color={r.channel.logoColor} />
                </TableCell>
                <TableCell className="font-medium">{r.channelPoNumber ?? "—"}</TableCell>
                <TableCell className={cn("text-xs", !r.emailRef && "text-muted-foreground")}>
                  {r.emailRef ?? "not issued"}
                </TableCell>
                <TableCell className="max-w-[180px] truncate text-xs" title={r.party ?? undefined}>
                  {r.party ?? <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{formatDate(r.approvedAt)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.warehouseCode ?? "—"}</TableCell>
                <TableCell className="text-center nums">{r.skuCount}</TableCell>
                <TableCell className="text-right whitespace-nowrap nums">
                  {formatNumber(r.ourQty)}
                  <span className="mx-1 text-muted-foreground">→</span>
                  {qtyUnknown ? (
                    <span className="text-muted-foreground" title="WMS doesn't expose SO line quantities">
                      not read
                    </span>
                  ) : (
                    <span className={cn("font-medium", off ? "text-danger" : "text-foreground")}>
                      {r.wmsQty == null ? "—" : formatNumber(r.wmsQty)}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {meta ? (
                    <Badge variant={meta.variant}>{meta.label}</Badge>
                  ) : (
                    <Badge variant="outline">Awaiting punch</Badge>
                  )}
                  {r.resolvedAt && (
                    <span className="ml-2 text-[10px] text-muted-foreground">✓ resolved</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <Dialog open={!!active} onOpenChange={(o) => !o && setOpenPo(null)}>
        <DialogContent className="max-w-2xl">
          {active && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2">
                  {active.result ? (
                    <Badge variant={SO_CHECK_META[active.result].variant}>
                      {SO_CHECK_META[active.result].label}
                    </Badge>
                  ) : (
                    <Badge variant="outline">Awaiting punch</Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {active.result ? SO_CHECK_META[active.result].hint : "no sales order read back yet"}
                  </span>
                </div>
                <DialogTitle>{active.channelPoNumber ?? active.poId}</DialogTitle>
                <p className="text-xs text-muted-foreground">
                  {active.channel.name} · {active.emailRef ?? "no MB ref issued"} ·{" "}
                  {formatNumber(active.ourQty)} units approved
                  {active.result === "QTY_UNVERIFIED"
                    ? " · punched quantity not exposed by WMS"
                    : active.wmsQty != null && <> · {formatNumber(active.wmsQty)} punched</>}
                  {active.valueAtRisk > 0 && <> · {formatINR(active.valueAtRisk)} at risk</>}
                </p>
              </DialogHeader>

              <div className="max-h-[60vh] space-y-5 overflow-auto pr-1">
                <section>
                  <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    SKU-wise quantity match
                  </h4>
                  {active.diff.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {active.result === "MATCHED"
                        ? "Every SKU ties out to the unit."
                        : active.result === "QTY_UNVERIFIED"
                          ? "The WMS read path returns SO headers only, so line quantities couldn't be compared. The SO exists and is traceable to this PO."
                          : "No quantity difference recorded for this PO."}
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>SKU</TableHead>
                          <TableHead className="text-right">Our qty</TableHead>
                          <TableHead className="text-right">WMS SO</TableHead>
                          <TableHead className="text-right">Diff</TableHead>
                          <TableHead className="text-right">₹ impact</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {active.diff.map((d) => {
                          const delta = d.wmsQty - d.ourQty;
                          return (
                            <TableRow key={d.skuCode}>
                              <TableCell>
                                <div className="font-medium">{d.skuCode}</div>
                                {d.name && <div className="text-xs text-muted-foreground">{d.name}</div>}
                              </TableCell>
                              <TableCell className="text-right nums">{formatNumber(d.ourQty)}</TableCell>
                              <TableCell className="text-right nums">{formatNumber(d.wmsQty)}</TableCell>
                              <TableCell className="text-right nums font-medium text-danger">
                                {delta > 0 ? `+${delta}` : delta}
                              </TableCell>
                              <TableCell className="text-right nums">
                                {d.valueImpact != null ? formatINR(d.valueImpact) : "—"}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                </section>

                <section>
                  <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {qtyUnknownFor(active) ? "PO reference on the SO" : "Both PO numbers present on the SO?"}
                  </h4>
                  <ul className="space-y-1.5 text-sm">
                    <RefRow ok={active.refs.channelPo} label="Channel PO number" value={active.channelPoNumber} />
                    <RefRow ok={active.refs.mbRef} label="MB reference" value={active.emailRef} />
                  </ul>
                  {qtyUnknownFor(active) && (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      The WMS feed exposes only one reference field per SO, so a missing tick here
                      means &ldquo;not in that field&rdquo; — not that the warehouse team left it off.
                      One traceable reference is all this check can confirm today.
                    </p>
                  )}
                </section>

                <section>
                  <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Sales orders punched ({active.salesOrders.length})
                  </h4>
                  {active.salesOrders.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No sales order in the WMS carries either of this PO&apos;s references.
                    </p>
                  ) : (
                    <ul className="space-y-1.5 text-sm">
                      {active.salesOrders.map((so) => (
                        <li key={so.id} className="rounded-lg border border-border/70 px-3 py-2">
                          <div className="font-medium">SO {so.id}</div>
                          <div className="text-xs text-muted-foreground">
                            {so.customer && <>{so.customer} · </>}
                            {so.warehouseCode && <>{so.warehouseCode} · </>}
                            {so.linesKnown ? "qty read" : "qty not read"} · order_no:{" "}
                            {so.orderNo ?? "—"} · ref_no: {so.refNo ?? "—"}
                            {so.partyRefOrderNo && <> · party_ref: {so.partyRefOrderNo}</>}
                            {so.orderDate && <> · {formatDate(so.orderDate)}</>}
                            {so.status && <> · {so.status}</>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section>
                  <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Timeline
                  </h4>
                  <ul className="space-y-1 text-sm">
                    <TimelineRow label="Approved" at={active.approvedAt} />
                    <TimelineRow label="PO email sent" at={active.emailSentAt} />
                    <TimelineRow
                      label="SO punched"
                      at={active.salesOrders.map((s) => s.orderDate).find(Boolean) ?? null}
                    />
                    <TimelineRow label="Last checked" at={active.checkedAt} />
                  </ul>
                </section>

                <Link href={`/orders/${active.poId}`} className="inline-block text-sm font-medium underline">
                  Open PO →
                </Link>
              </div>

              <div className="flex items-center gap-2 border-t border-border/70 pt-4">
                {active.resolvedAt ? (
                  <>
                    <p className="flex-1 text-xs text-muted-foreground">
                      <span className="font-semibold text-success">✓ Resolved</span> by{" "}
                      {active.resolvedBy ?? "—"} · {formatDateTime(active.resolvedAt)}
                      {active.note && <> · {active.note}</>}
                    </p>
                    <Button variant="outline" disabled={busy} onClick={() => resolve(active.poId, "reopen")}>
                      {busy && <Loader2 className="h-4 w-4 animate-spin" />} Reopen
                    </Button>
                  </>
                ) : (
                  <>
                    <Input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Add a resolution note…"
                      className="flex-1"
                    />
                    <Button
                      disabled={
                        busy ||
                        !active.result ||
                        active.result === "MATCHED" ||
                        active.result === "QTY_UNVERIFIED"
                      }
                      title={
                        active.result === "QTY_UNVERIFIED"
                          ? "Nothing to resolve — the SO is there; only the quantity check is unavailable"
                          : undefined
                      }
                      onClick={() => resolve(active.poId, "resolve")}
                    >
                      {busy && <Loader2 className="h-4 w-4 animate-spin" />} Resolve
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** True when the read path gave headers only, so quantities are unknown for this row. */
function qtyUnknownFor(row: SoCheckRow): boolean {
  return row.result === "QTY_UNVERIFIED";
}

function RefRow({ ok, label, value }: { ok: boolean; label: string; value: string | null }) {
  return (
    <li className="flex items-center gap-2 rounded-lg border border-border/70 px-3 py-2">
      <span className={ok ? "text-success" : "text-muted-foreground"}>{ok ? "✓" : "—"}</span>
      <span className="flex-1">{label}</span>
      <span className="text-xs text-muted-foreground">{value ?? "not issued"}</span>
    </li>
  );
}

function TimelineRow({ label, at }: { label: string; at: Date | string | null }) {
  return (
    <li className="flex items-center gap-2">
      <span className={cn("h-2 w-2 rounded-full", at ? "bg-success" : "bg-border")} />
      <span className={cn("flex-1", !at && "text-muted-foreground")}>{label}</span>
      <span className="text-xs text-muted-foreground">{at ? formatDateTime(at) : "pending"}</span>
    </li>
  );
}
