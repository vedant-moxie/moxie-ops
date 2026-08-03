import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, Truck, Mail, FileText } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/orders/status-badge";
import { PriorityBadge } from "@/components/dashboard/priority-badge";
import { ChannelChip } from "@/components/shared/channel-chip";
import { ResendEmailModal } from "@/components/orders/resend-email-modal";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { prisma } from "@/lib/db";
import { validatePoTaxables } from "@/lib/services/taxable-validation";
import { resolveLineInternalSku, pvIdFromRaw } from "@/lib/services/sku-resolver";
import { computeFillRates } from "@/lib/services/fill-rate";
import { SO_CHECK_META } from "@/lib/status";
import { cn, formatINR, formatDate, formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function OrderDetailPage({ params }: { params: { id: string } }) {
  const poBase = await prisma.purchaseOrder.findUnique({
    where: { id: params.id },
    include: {
      channel: true,
      lineItems: { include: { sku: true } },
      warehouseInstruction: true,
      dispatchRecord: { include: { lineItems: true } },
      deliveryRecord: true,
      grnRecord: { include: { lineItems: true, discrepancies: true } },
      invoice: true,
      soCheck: true,
    },
  });
  if (!poBase) notFound();
  const auditLogs = await prisma.auditLog.findMany({
    where: { entityType: "PurchaseOrder", entityId: params.id },
    orderBy: { createdAt: "asc" },
  });
  const po = { ...poBase, auditLogs };

  const taxValidation = validatePoTaxables(po);
  const taxByLine = new Map(taxValidation.lines.map((l) => [l.lineId, l]));

  const dispatchedBySku = new Map(po.dispatchRecord?.lineItems.map((l) => [l.skuId, l.dispatchedQty]) ?? []);
  const receivedBySku = new Map(po.grnRecord?.lineItems.map((l) => [l.skuId, l.receivedQty]) ?? []);

  // Gross (delivered ÷ ordered) + net (delivered ÷ assigned) fill rates.
  // "assigned" = team allocation (approvedQty) or the channel's scraped ASN qty.
  const fill = computeFillRates(
    po.lineItems.map((l) => ({
      skuId: l.skuId,
      requestedQty: l.requestedQty,
      approvedQty: l.approvedQty,
      rawData: l.rawData,
    })),
    po.grnRecord?.lineItems ?? null,
  );
  const fillBySku = new Map(fill.perLine.map((l) => [l.skuId, l]));
  // Once a PO has a GRN it's delivered & received — the allocate action no longer applies.
  const isReceived = po.grnRecord != null;

  const grnIsPerfect = po.grnRecord != null && po.lineItems.every((li) => {
    const received = receivedBySku.get(li.skuId) ?? 0;
    return received === li.requestedQty;
  });

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

        {/* Taxable mismatch banner */}
        {taxValidation.hasTaxableMismatch && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-700 dark:bg-amber-950/30">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="text-sm">
              <span className="font-semibold text-amber-800 dark:text-amber-300">Taxable value mismatch</span>
              <span className="ml-1.5 text-amber-700 dark:text-amber-400">
                {taxValidation.lines.filter((l) => l.mismatch).length} line{taxValidation.lines.filter((l) => l.mismatch).length !== 1 ? "s" : ""} differ from SKU master expected prices.
                Review before sending the allocation email.
              </span>
            </div>
          </div>
        )}

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
            {po.emailRef && (
              <div>
                <div className="text-xs text-muted-foreground">Email reference</div>
                <div className="font-medium font-mono">{po.emailRef}</div>
                <div className="mt-0.5"><EmailStatusBadge status={po.emailStatus} sentAt={po.emailSentAt} /></div>
              </div>
            )}
            {po.soCheck && (
              <div>
                <div className="text-xs text-muted-foreground">WMS sales order</div>
                <div className="mt-0.5">
                  <Link href="/reconciliation/so-check">
                    <Badge variant={SO_CHECK_META[po.soCheck.result].variant}>
                      {SO_CHECK_META[po.soCheck.result].label}
                    </Badge>
                  </Link>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground nums">
                  {po.soCheck.ourQty} ours → {po.soCheck.wmsQty} punched
                  {po.soCheck.resolvedAt && " · resolved"}
                </div>
              </div>
            )}
            <div className="ml-auto flex flex-wrap gap-2">
              {(po.emailStatus === "HELD" || po.emailStatus === "FAILED") && (
                <ResendEmailModal poId={po.id} buttonLabel="Fix recipients & resend" />
              )}
              {po.emailStatus === "SENT" && (
                <ResendEmailModal poId={po.id} buttonLabel="Resend email" buttonVariant="outline" />
              )}
              <ContextActions status={po.status} poId={po.id} hasGrn={isReceived} />
            </div>
          </CardContent>
        </Card>

        {/* Undelivered email banner — the PO allocated but its email reached no one. */}
        {(po.emailStatus === "HELD" || po.emailStatus === "FAILED") && (
          <Card className="mb-6 border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30">
            <CardContent className="flex flex-wrap items-center gap-3 p-4">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="text-sm text-amber-800 dark:text-amber-300">
                <span className="font-semibold">
                  Email not delivered {po.emailRef ? <span className="font-mono">({po.emailRef})</span> : null}.
                </span>{" "}
                {po.emailHoldReason ?? "This PO's email reached no one."} Add recipients and resend — it keeps the same reference.
              </div>
              <div className="ml-auto">
                <ResendEmailModal poId={po.id} buttonLabel="Fix recipients & resend" />
              </div>
            </CardContent>
          </Card>
        )}

        <div className="space-y-6">
          {/* Combined line items + GRN table */}
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 flex-wrap gap-2">
              <CardTitle className="flex flex-wrap items-center gap-2">
                Items · {po.lineItems.length}
                {isReceived && (
                  <>
                    <Badge
                      variant={grnIsPerfect ? "success" : fill.grossPct != null && fill.grossPct < 80 ? "danger" : "warning"}
                      className="ml-1"
                    >
                      Gross {fill.grossPct ?? 0}%{grnIsPerfect ? " · Perfect" : ""}
                    </Badge>
                    {fill.netPct != null ? (
                      <Badge variant={fill.netPct < 80 ? "danger" : fill.netPct >= 100 ? "success" : "warning"}>
                        Net {fill.netPct}%
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground" title="No assigned/ASN quantity yet.">
                        Net —
                      </Badge>
                    )}
                  </>
                )}
              </CardTitle>
              {!isReceived && (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/allocate/${po.id}`}>Allocate this PO</Link>
                </Button>
              )}
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>SKU</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Ordered</TableHead>
                    <TableHead className="text-right">Received</TableHead>
                    <TableHead className="text-right">Allocated</TableHead>
                    <TableHead className="text-right">Fill</TableHead>
                    <TableHead className="text-right">Variance</TableHead>
                    <TableHead className="text-right">Taxable/unit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {po.lineItems.map((li) => {
                    const received = receivedBySku.get(li.skuId);
                    const ordered = li.requestedQty;
                    const lineFill = fillBySku.get(li.skuId);
                    const assigned = lineFill?.assigned ?? null;
                    const fillPct = isReceived
                      ? lineFill?.grossPct ?? null
                      : assigned != null && ordered > 0
                        ? (assigned / ordered) * 100
                        : null;
                    const fillTone =
                      fillPct == null ? "text-muted-foreground"
                        : fillPct >= 100 ? "text-success"
                        : fillPct > 0 ? "text-warning"
                        : "text-danger";
                    const variance = received != null ? received - ordered : null;
                    const varianceTone =
                      variance == null ? ""
                        : variance === 0 ? "text-success"
                        : variance < 0 ? "text-danger"
                        : "text-warning";
                    const tv = taxByLine.get(li.id);
                    return (
                      <TableRow key={li.id} className={tv?.mismatch ? "bg-amber-50/50 dark:bg-amber-950/10" : undefined}>
                        <TableCell className="font-mono text-xs">{resolveLineInternalSku({ source: po.channel.name, channelCode: li.channelSkuCode ?? li.sku.internalCode, pvId: pvIdFromRaw(li.rawData) })}</TableCell>
                        <TableCell className="max-w-[280px]">
                          <div className="truncate text-sm">{li.sku.name}</div>
                        </TableCell>
                        <TableCell className="text-right nums font-medium">{ordered}</TableCell>
                        <TableCell className="text-right nums">
                          {received != null ? received : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-right nums">
                          {assigned != null ? assigned : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className={cn("text-right nums font-medium", fillTone)}>
                          {fillPct != null ? `${Math.round(fillPct)}%` : "—"}
                        </TableCell>
                        <TableCell className={cn("text-right nums font-medium", varianceTone)}>
                          {variance == null ? "—" : variance === 0 ? "—" : variance > 0 ? `+${variance}` : variance}
                        </TableCell>
                        <TableCell className="text-right">
                          {tv?.mismatch ? (
                            <span
                              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                              title={tv.reason}
                            >
                              <AlertTriangle className="h-3 w-3" />
                              ₹{tv.actual?.toFixed(2) ?? "?"} / exp ₹{tv.expected?.toFixed(2) ?? "?"}
                            </span>
                          ) : tv?.actual != null ? (
                            <span className="nums text-sm text-muted-foreground">₹{tv.actual.toFixed(2)}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

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
        </div>
      </main>
    </>
  );
}

/** Delivery state of the PO-preparation email (mirrors PurchaseOrder.emailStatus). */
function EmailStatusBadge({ status, sentAt }: { status: string; sentAt: Date | null }) {
  switch (status) {
    case "SENT":
      return (
        <span className="text-[11px] text-muted-foreground">
          issued{sentAt ? ` ${formatDateTime(sentAt)} IST` : ""}
        </span>
      );
    case "HELD":
      return <Badge variant="warning">Not delivered — needs resend</Badge>;
    case "FAILED":
      return <Badge variant="danger">Send failed — needs resend</Badge>;
    default:
      return <span className="text-[11px] text-muted-foreground">not sent</span>;
  }
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}

function ContextActions({ status, poId, hasGrn }: { status: string; poId: string; hasGrn: boolean }) {
  // Once goods are received (GRN exists) the PO is delivered — allocation no longer
  // applies, so suppress the allocate/manage actions regardless of lagging status.
  if (hasGrn && (status === "PENDING_REVIEW" || status === "PRIORITISED" || status === "APPROVED")) {
    return null;
  }
  switch (status) {
    case "PENDING_REVIEW":
    case "PRIORITISED":
      return (
        <Button asChild><Link href={`/allocate/${poId}`}>Allocate this PO</Link></Button>
      );
    case "APPROVED":
      return (
        <Button variant="outline" asChild>
          <Link href={`/allocate/${poId}`}><Mail className="h-4 w-4" /> Manage allocation</Link>
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
