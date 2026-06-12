import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, Lock } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent } from "@/components/ui/card";
import { ChannelChip } from "@/components/shared/channel-chip";
import { StatusBadge } from "@/components/orders/status-badge";
import { PoAllocator } from "@/components/allocation/po-allocator";
import { getPoForAllocation } from "@/lib/data/queries";
import { validatePoTaxables } from "@/lib/services/taxable-validation";
import { resolveInternalSku } from "@/lib/services/sku-resolver";
import { currentActor } from "@/lib/auth";
import { isClaimedByOther } from "@/lib/services/po-claim";
import { readWarehouseStock } from "@/lib/services/wms-stock-sync";
import { resolveDispatchFromForPo } from "@/lib/services/po-documents";
import { warehouseByDispatchFrom } from "@/lib/warehouses";
import { formatINR, formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AllocatePoPage({ params }: { params: { id: string } }) {
  const po = await getPoForAllocation(params.id);
  if (!po) notFound();

  const actor = await currentActor();
  const lockedByOther = isClaimedByOther(po, actor.id);

  const receivedBySku: Record<string, number> = {};
  for (const l of po.grnRecord?.lineItems ?? []) receivedBySku[l.skuId] = l.receivedQty;

  const skuIds = po.lineItems.map((l) => l.skuId);
  // Live WMS stock + the shipping warehouse (from the GSTIN on the PO PDF), in parallel
  const [warehouseStock, dispatch] = await Promise.all([
    readWarehouseStock(skuIds).catch(() => ({})),
    resolveDispatchFromForPo(po).catch(() => null),
  ]);

  // SKUs that have no WMS stock entry AND whose internalCode looks like a raw channel item ID
  // (all digits) are candidates for AI mapping. Surface them to the client so the review
  // banner can offer to resolve them on demand.
  const unmappedSkuIds = po.lineItems
    .filter((l) => {
      const entries = (warehouseStock as Record<string, unknown[]>)[l.skuId];
      return (
        (!entries || entries.length === 0) &&
        /^\d{6,}$/.test(l.sku.internalCode)
      );
    })
    .map((l) => l.skuId);
  const dispatchWarehouse = dispatch?.dispatchFrom
    ? warehouseByDispatchFrom(dispatch.dispatchFrom)
    : null;

  const taxValidation = validatePoTaxables(po);
  const mismatchLines = taxValidation.lines.filter((l) => l.mismatch);
  const flagByLine = new Map(taxValidation.lines.map((l) => [l.lineId, l]));

  return (
    <>
      <Topbar title={`Allocate · ${po.channelPoNumber ?? "PO"}`} subtitle={po.channel.name} />
      <main className="flex-1 px-5 py-6 lg:px-8">
        <Link href="/allocate" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to allocation
        </Link>

        {lockedByOther && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-900/40">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-slate-600 dark:text-slate-300" />
            <div className="text-sm">
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                Being allocated by {po.claimedByLabel ?? "another user"}
              </span>
              <span className="ml-1.5 text-slate-600 dark:text-slate-400">
                This PO is locked while they work on it (auto-unlocks after inactivity). It&apos;s read-only for you.
              </span>
            </div>
          </div>
        )}

        {taxValidation.hasUnmappedSku && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 dark:border-rose-700 dark:bg-rose-950/30">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
            <div className="text-sm">
              <span className="font-semibold text-rose-800 dark:text-rose-300">Unmapped SKU(s) — map them or remove before sending</span>
              <ul className="mt-1 space-y-0.5 text-rose-700 dark:text-rose-400">
                {taxValidation.lines.filter((l) => l.unmapped).map((l) => (
                  <li key={l.lineId}>
                    <span className="font-mono">{resolveInternalSku(po.channel.name, l.channelSkuCode ?? l.sku)}</span>
                    {" — new/unknown SKU not in the "}{po.channel.name}{" master"}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {taxValidation.hasTaxableMismatch && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-700 dark:bg-amber-950/30">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="text-sm">
              <span className="font-semibold text-amber-800 dark:text-amber-300">Taxable value mismatch — review before sending</span>
              <ul className="mt-1 space-y-0.5 text-amber-700 dark:text-amber-400">
                {mismatchLines.map((l) => (
                  <li key={l.lineId}>
                    <span className="font-mono">{resolveInternalSku(po.channel.name, l.channelSkuCode ?? l.sku)}</span>
                    {" — "}{l.reason}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <Card className="mb-6">
          <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-4 p-5">
            <ChannelChip name={po.channel.name} color={po.channel.logoColor} tier={po.channel.tier} />
            <div><div className="text-xs text-muted-foreground">PO Number</div><div className="font-medium">{po.channelPoNumber}</div></div>
            <div><div className="text-xs text-muted-foreground">Status</div><div className="mt-0.5"><StatusBadge status={po.status} /></div></div>
            <div><div className="text-xs text-muted-foreground">PO date</div><div className="font-medium">{formatDate(po.poDate)}</div></div>
            <div><div className="text-xs text-muted-foreground">Value</div><div className="font-medium nums">{formatINR(po.totalRequestedValue)}</div></div>
            <div><div className="text-xs text-muted-foreground">Items</div><div className="font-medium nums">{po.lineItems.length}</div></div>
          </CardContent>
        </Card>

        <PoAllocator
          poId={po.id}
          lines={po.lineItems.map((l) => {
            const f = flagByLine.get(l.id);
            return {
              ...l,
              rawData: (l.rawData as Record<string, string> | null),
              // Internal/master SKU code for display — resolved server-side where the
              // DB-backed master maps are live (the client bundle only has file defaults).
              // Falls back to the raw platform code for still-unmapped SKUs (flagged below).
              displaySkuCode: resolveInternalSku(po.channel.name, l.channelSkuCode ?? l.sku.internalCode),
              flag: f ? { mismatch: f.mismatch, unmapped: f.unmapped, reason: f.reason } : null,
            };
          })}
          receivedBySku={receivedBySku}
          warehouseStock={warehouseStock}
          dispatchWarehouseCode={dispatchWarehouse?.code ?? null}
          dispatchWarehouseName={dispatchWarehouse?.wmsName ?? dispatch?.dispatchFrom ?? null}
          hasTaxableMismatch={taxValidation.hasTaxableMismatch}
          lockedByOther={lockedByOther}
          unmappedSkuIds={unmappedSkuIds}
        />
      </main>
    </>
  );
}
