import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { Link2Off } from "lucide-react";
import type { UnmatchedSalesOrder } from "@/lib/data/queries";
import { formatDate, formatNumber } from "@/lib/utils";

/**
 * Sales orders sitting in the WMS that no approved PO claimed. Read-only — there is
 * nothing to resolve here; the fix is either the warehouse team's reference or a PO
 * that never reached the portal.
 */
export function UnmatchedSoTable({ rows }: { rows: UnmatchedSalesOrder[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Link2Off}
        title="Every sales order is accounted for"
        description="Each SO in the WMS window carries a reference that maps to one of our approved POs."
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>WMS sales order</TableHead>
          <TableHead>Reference on the SO</TableHead>
          <TableHead>Party</TableHead>
          <TableHead>WH</TableHead>
          <TableHead>Order date</TableHead>
          <TableHead className="text-center">SKUs</TableHead>
          <TableHead className="text-right">Units</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="font-medium">{r.id}</TableCell>
            <TableCell className="text-xs">
              {r.orderNo ?? r.refNo ?? <span className="text-danger">no reference</span>}
            </TableCell>
            <TableCell className="max-w-[200px] truncate text-xs" title={r.customer ?? undefined}>
              {r.customer ?? "—"}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{r.warehouseCode ?? "—"}</TableCell>
            <TableCell className="text-xs text-muted-foreground">{formatDate(r.orderDate)}</TableCell>
            <TableCell className="text-center nums">{r.linesKnown ? r.skuCount : "—"}</TableCell>
            <TableCell className="text-right nums">
              {r.linesKnown ? formatNumber(r.totalQty) : <span className="text-muted-foreground">not read</span>}
            </TableCell>
            <TableCell>
              <Badge variant="outline">{r.status ?? "—"}</Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
