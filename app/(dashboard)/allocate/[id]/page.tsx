import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent } from "@/components/ui/card";
import { ChannelChip } from "@/components/shared/channel-chip";
import { StatusBadge } from "@/components/orders/status-badge";
import { PoAllocator } from "@/components/allocation/po-allocator";
import { getPoForAllocation } from "@/lib/data/queries";
import { validatePoTaxables } from "@/lib/services/taxable-validation";
import { formatINR, formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AllocatePoPage({ params }: { params: { id: string } }) {
  const po = await getPoForAllocation(params.id);
  if (!po) notFound();

  const receivedBySku: Record<string, number> = {};
  for (const l of po.grnRecord?.lineItems ?? []) receivedBySku[l.skuId] = l.receivedQty;

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

        {taxValidation.hasUnmappedSku && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 dark:border-rose-700 dark:bg-rose-950/30">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
            <div className="text-sm">
              <span className="font-semibold text-rose-800 dark:text-rose-300">Unmapped SKU(s) — map them or remove before sending</span>
              <ul className="mt-1 space-y-0.5 text-rose-700 dark:text-rose-400">
                {taxValidation.lines.filter((l) => l.unmapped).map((l) => (
                  <li key={l.lineId}>
                    <span className="font-mono">{l.channelSkuCode ?? l.sku}</span>
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
                    <span className="font-mono">{l.channelSkuCode ?? l.sku}</span>
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
              flag: f ? { mismatch: f.mismatch, unmapped: f.unmapped, reason: f.reason } : null,
            };
          })}
          receivedBySku={receivedBySku}
          hasTaxableMismatch={taxValidation.hasTaxableMismatch}
        />
      </main>
    </>
  );
}
