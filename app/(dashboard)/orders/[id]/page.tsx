import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Truck, Mail, FileText, PackageCheck } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/orders/status-badge";
import { PriorityBadge } from "@/components/dashboard/priority-badge";
import { ChannelChip } from "@/components/shared/channel-chip";
import { OrderTimeline } from "@/components/orders/order-timeline";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { prisma } from "@/lib/db";
import { cn, formatINR, formatDate, formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function OrderDetailPage({ params }: { params: { id: string } }) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: params.id },
    include: {
      channel: true,
      lineItems: { include: { sku: true } },
      warehouseInstruction: true,
      dispatchRecord: { include: { lineItems: true } },
      deliveryRecord: true,
      grnRecord: { include: { lineItems: true, discrepancies: true } },
      invoice: true,
      auditLogs: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!po) notFound();

  const dispatchedBySku = new Map(po.dispatchRecord?.lineItems.map((l) => [l.skuId, l.dispatchedQty]) ?? []);
  const receivedBySku = new Map(po.grnRecord?.lineItems.map((l) => [l.skuId, l.receivedQty]) ?? []);

  // Compute ordered-vs-received discrepancy breakdown for GRN section
  const grnVariances = po.grnRecord
    ? (() => {
        const orderedBySku = new Map(po.lineItems.map((l) => [l.skuId, l.requestedQty]));
        const allSkuIds = new Set([...orderedBySku.keys(), ...receivedBySku.keys()]);
        return Array.from(allSkuIds).map((skuId) => {
          const ordered = orderedBySku.get(skuId) ?? 0;
          const received = receivedBySku.get(skuId) ?? 0;
          const li = po.lineItems.find((l) => l.skuId === skuId);
          const grnLi = po.grnRecord!.lineItems.find((l) => l.skuId === skuId);
          return {
            skuId,
            internalCode: li?.sku.internalCode ?? grnLi?.skuId ?? skuId,
            name: li?.sku.name ?? "—",
            channelSkuCode: li?.channelSkuCode ?? null,
            ordered,
            received,
            variance: received - ordered,
          };
        });
      })()
    : null;

  const totalOrdered = po.lineItems.reduce((s, l) => s + l.requestedQty, 0);
  const totalReceived = po.grnRecord
    ? po.grnRecord.lineItems.reduce((s, l) => s + l.receivedQty, 0)
    : null;
  const fillRatePct =
    totalOrdered > 0 && totalReceived != null
      ? Math.round((totalReceived / totalOrdered) * 100)
      : null;
  const grnIsPerfect = grnVariances != null && grnVariances.every((v) => v.variance === 0);

  return (
    <>
      <Topbar title={po.channelPoNumber ?? "Order"} subtitle={po.channel.name} />
      <main className="flex-1 px-5 py-6 lg:px-8">
        <Link
          href="/orders"
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to orders
        </Link>

        {/* Header card */}
        <Card className="mb-6">
          <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-4 p-5">
            <ChannelChip name={po.channel.name} color={po.channel.logoColor} tier={po.channel.tier} />
            <div>
              <div className="text-xs text-muted-foreground">PO Number</div>
              <div className="font-medium">{po.channelPoNumber ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Status</div>
              <div className="mt-0.5"><StatusBadge status={po.status} /></div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Priority</div>
              <div className="mt-0.5"><PriorityBadge poId={po.id} priority={po.priority} /></div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Total value</div>
              <div className="font-medium nums">{formatINR(po.totalRequestedValue)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Requested delivery</div>
              <div className="font-medium">{formatDate(po.requestedDeliveryDate)}</div>
            </div>
            <div className="ml-auto flex flex-wrap gap-2">
              <ContextActions status={po.status} poId={po.id} />
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
          {/* Line items */}
          <div className="space-y-6">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle>Items · {po.lineItems.length}</CardTitle>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/allocate/${po.id}`}>Allocate this PO</Link>
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Item ID</TableHead>
                      <TableHead>UPC</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>UOM</TableHead>
                      <TableHead className="text-right">Ordered</TableHead>
                      <TableHead className="text-right">Received (GRN)</TableHead>
                      <TableHead className="text-right">Allocated</TableHead>
                      <TableHead className="text-right">Fill</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {po.lineItems.map((li) => {
                      const raw = (li.rawData as Record<string, string> | null) ?? {};
                      const received = receivedBySku.get(li.skuId);
                      const ordered = li.requestedQty;
                      const fillBase = li.approvedQty ?? received ?? null;
                      const fillPct = ordered > 0 && fillBase != null ? (fillBase / ordered) * 100 : null;
                      const tone =
                        fillPct == null ? "text-muted-foreground"
                          : fillPct >= 100 ? "text-success"
                          : fillPct > 0 ? "text-warning"
                          : "text-danger";
                      return (
                        <TableRow key={li.id}>
                          <TableCell className="font-mono text-xs">{li.channelSkuCode ?? li.sku.internalCode}</TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{raw.upc ?? "—"}</TableCell>
                          <TableCell className="max-w-[280px]">
                            <div className="truncate text-sm">{li.sku.name}</div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{raw.uom_text ?? li.sku.uom}</TableCell>
                          <TableCell className="text-right nums font-medium">{ordered}</TableCell>
                          <TableCell className="text-right nums">
                            {received != null ? received : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className="text-right nums">{li.approvedQty ?? "—"}</TableCell>
                          <TableCell className={cn("text-right nums font-medium", tone)}>
                            {fillPct != null ? `${Math.round(fillPct)}%` : "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Ordered vs Received (GRN) breakdown */}
            {po.grnRecord && grnVariances && (
              <Card id="grn">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <PackageCheck className="h-4 w-4 text-muted-foreground" />
                    Ordered vs Received · GRN
                    {grnIsPerfect ? (
                      <Badge variant="success" className="ml-2">100% · Perfect</Badge>
                    ) : (
                      <Badge variant={fillRatePct != null && fillRatePct < 80 ? "danger" : "warning"} className="ml-2">
                        {fillRatePct ?? 0}% · {grnVariances.filter((v) => v.variance !== 0).length} SKU{grnVariances.filter((v) => v.variance !== 0).length !== 1 ? "s" : ""} differ
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>SKU</TableHead>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Ordered</TableHead>
                        <TableHead className="text-right">Received</TableHead>
                        <TableHead className="text-right">Variance</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {grnVariances.map((v) => {
                        const tone =
                          v.variance === 0 ? "text-success"
                            : v.variance < 0 ? "text-danger"
                            : "text-warning";
                        return (
                          <TableRow key={v.skuId} className={v.variance !== 0 ? "bg-muted/30" : undefined}>
                            <TableCell className="font-mono text-xs">
                              {v.channelSkuCode ?? v.internalCode}
                            </TableCell>
                            <TableCell>
                              <div className="text-sm">{v.name}</div>
                              {v.channelSkuCode && (
                                <div className="text-xs text-muted-foreground">{v.internalCode}</div>
                              )}
                            </TableCell>
                            <TableCell className="text-right nums">{v.ordered}</TableCell>
                            <TableCell className="text-right nums">{v.received}</TableCell>
                            <TableCell className={cn("text-right nums font-medium", tone)}>
                              {v.variance === 0 ? "—" : v.variance > 0 ? `+${v.variance}` : v.variance}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            {(po.dispatchRecord || po.invoice) && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {po.dispatchRecord && (
                  <Card className="p-5">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <Truck className="h-4 w-4 text-muted-foreground" /> Dispatch
                    </div>
                    <Separator className="my-3" />
                    <dl className="space-y-1.5 text-sm">
                      <Row k="AWB" v={po.dispatchRecord.awbNumber ?? "—"} />
                      <Row k="Carrier" v={po.dispatchRecord.carrierName ?? "—"} />
                      <Row k="Dispatched" v={formatDateTime(po.dispatchRecord.dispatchedAt)} />
                    </dl>
                  </Card>
                )}
                {po.invoice && (
                  <Card className="p-5">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <FileText className="h-4 w-4 text-muted-foreground" /> Invoice
                    </div>
                    <Separator className="my-3" />
                    <dl className="space-y-1.5 text-sm">
                      <Row k="Number" v={po.invoice.invoiceNumber} />
                      <Row k="Amount" v={formatINR(po.invoice.totalAmount, { decimals: true })} />
                      <Row k="GST" v={formatINR(po.invoice.gstAmount, { decimals: true })} />
                    </dl>
                  </Card>
                )}
              </div>
            )}

            {po.rawData && typeof po.rawData === "object" && (
              <Card>
                <CardHeader>
                  <CardTitle>Source data · {po.source}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
                    {Object.entries(po.rawData as Record<string, unknown>)
                      .filter(([, v]) => String(v ?? "").trim() !== "")
                      .map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-3 border-b border-border/40 py-1 text-sm">
                          <span className="text-muted-foreground">{k}</span>
                          <span className="text-right font-medium">{String(v)}</span>
                        </div>
                      ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Timeline */}
          <Card className="h-fit">
            <CardHeader><CardTitle>Timeline</CardTitle></CardHeader>
            <CardContent>
              <OrderTimeline events={po.auditLogs} />
            </CardContent>
          </Card>
        </div>
      </main>
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}

function ContextActions({ status, poId }: { status: string; poId: string }) {
  switch (status) {
    case "PENDING_REVIEW":
    case "PRIORITISED":
      return (
        <Button asChild><Link href="/allocate">Go to allocation grid</Link></Button>
      );
    case "APPROVED":
      return (
        <Button variant="outline" asChild>
          <Link href="/allocate"><Mail className="h-4 w-4" /> Manage allocation</Link>
        </Button>
      );
    case "DELIVERED":
      return (
        <Button asChild><Link href="/grn/upload">Upload GRN manually</Link></Button>
      );
    case "DISCREPANCY":
      return (
        <Button asChild><Link href="/reconciliation">Resolve discrepancy</Link></Button>
      );
    default:
      return null;
  }
}
