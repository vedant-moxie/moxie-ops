"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Wand2, PackageCheck, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { cn, formatNumber } from "@/lib/utils";

interface Line {
  id: string;
  skuId: string;
  channelSkuCode: string | null;
  requestedQty: number;
  approvedQty: number | null;
  rawData: Record<string, string> | null;
  sku: { internalCode: string; name: string; uom: string };
}

export function PoAllocator({
  poId,
  lines,
  receivedBySku,
  hasTaxableMismatch = false,
}: {
  poId: string;
  lines: Line[];
  receivedBySku: Record<string, number>;
  hasTaxableMismatch?: boolean;
}) {
  const router = useRouter();
  const [alloc, setAlloc] = useState<Record<string, number>>(() =>
    Object.fromEntries(lines.map((l) => [l.skuId, l.approvedQty ?? l.requestedQty ?? 0])),
  );
  const [rawInputs, setRawInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.skuId, String(l.approvedQty ?? l.requestedQty ?? 0)])),
  );
  const [saving, setSaving] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);

  const set = (skuId: string, raw: string) => {
    setRawInputs((p) => ({ ...p, [skuId]: raw }));
    setAlloc((p) => ({ ...p, [skuId]: Math.max(0, Math.floor(Number(raw) || 0)) }));
  };

  const fillOrdered = () => {
    setAlloc(Object.fromEntries(lines.map((l) => [l.skuId, l.requestedQty])));
    setRawInputs(Object.fromEntries(lines.map((l) => [l.skuId, String(l.requestedQty)])));
  };
  const matchReceived = () => {
    const nums = Object.fromEntries(lines.map((l) => [l.skuId, receivedBySku[l.skuId] ?? 0]));
    setAlloc(nums);
    setRawInputs(Object.fromEntries(Object.entries(nums).map(([k, v]) => [k, String(v)])));
  };

  const totalOrdered = lines.reduce((s, l) => s + l.requestedQty, 0);
  const totalAlloc = lines.reduce((s, l) => s + (alloc[l.skuId] ?? 0), 0);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/pos/${poId}/allocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allocations: lines.map((l) => ({ skuId: l.skuId, approvedQty: alloc[l.skuId] ?? 0 })),
          // The confirm-send click acknowledges any price mismatch (server gate).
          acknowledge: confirmSend,
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      if (json.data?.mismatchWithheld) {
        toast.warning(
          `Allocation saved · email withheld — ${json.data.mismatches?.length ?? 0} price mismatch(es). Review and confirm to send.`,
        );
      } else {
        toast.success(`Allocation saved · ${formatNumber(totalAlloc)} units · email sent to abhishek@moxiebeauty.in`);
      }
      router.push("/allocate");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={fillOrdered}>
          <Wand2 className="h-4 w-4" /> Fill all to ordered
        </Button>
        <Button variant="outline" size="sm" onClick={matchReceived}>
          <PackageCheck className="h-4 w-4" /> Match received
        </Button>
        <div className="ml-auto text-sm text-muted-foreground">
          Allocating <span className="font-semibold text-foreground nums">{formatNumber(totalAlloc)}</span> of{" "}
          <span className="nums">{formatNumber(totalOrdered)}</span> ordered units
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-soft">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Item ID</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>UOM</TableHead>
              <TableHead className="text-right">Ordered</TableHead>
              <TableHead className="text-right">Received</TableHead>
              <TableHead className="text-right">Allocate</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => {
              const received = receivedBySku[l.skuId];
              const val = alloc[l.skuId] ?? 0;
              const tone =
                val === 0 ? "border-border/60"
                  : val >= l.requestedQty ? "border-success"
                  : "border-warning";
              return (
                <TableRow key={l.id}>
                  <TableCell className="font-mono text-xs">{l.channelSkuCode ?? l.sku.internalCode}</TableCell>
                  <TableCell className="max-w-[320px]"><div className="truncate text-sm">{l.sku.name}</div></TableCell>
                  <TableCell className="text-muted-foreground">{l.rawData?.uom_text ?? l.sku.uom}</TableCell>
                  <TableCell className="text-right nums font-medium">{l.requestedQty}</TableCell>
                  <TableCell className="text-right nums">
                    {received != null ? received : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    <input
                      type="number"
                      min={0}
                      value={rawInputs[l.skuId] ?? ""}
                      onChange={(e) => set(l.skuId, e.target.value)}
                      onBlur={() =>
                        setRawInputs((p) => ({ ...p, [l.skuId]: String(alloc[l.skuId] ?? 0) }))
                      }
                      className={cn(
                        "h-9 w-24 rounded-lg border bg-card px-2 text-right text-sm nums outline-none focus:ring-2 focus:ring-ring/40",
                        tone,
                      )}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => router.push("/allocate")} disabled={saving}>Cancel</Button>
        <Button
          onClick={() => hasTaxableMismatch && !confirmSend ? setConfirmSend(true) : save()}
          disabled={saving}
          className={hasTaxableMismatch && !confirmSend ? "gap-2 bg-amber-600 hover:bg-amber-700 text-white border-0" : "gap-2"}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : hasTaxableMismatch && !confirmSend ? <AlertTriangle className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
          {hasTaxableMismatch && !confirmSend ? "Price mismatch — click again to confirm send" : "Save allocation & send email"}
        </Button>
      </div>
    </div>
  );
}
