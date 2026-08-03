import { AlertTriangle, CheckCheck, ClipboardX, Hash } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/dashboard/summary-stats";
import { SoCheckTable } from "@/components/reconciliation/so-check-table";
import { UnmatchedSoTable } from "@/components/reconciliation/unmatched-so-table";
import { getSoCheckRows, getUnmatchedSalesOrders } from "@/lib/data/queries";
import { soReadPathConfigured } from "@/lib/services/so-verification";
import { env } from "@/lib/env";
import { formatINR, formatNumber, relativeTime } from "@/lib/utils";
import { SO_CHECK_PROBLEMS } from "@/lib/status";

export const dynamic = "force-dynamic";

export default async function SoCheckPage() {
  const windowDays = env.SO_CHECK_WINDOW_DAYS;
  const [{ rows, lastCheckedAt }, unmatched] = await Promise.all([
    getSoCheckRows(windowDays),
    getUnmatchedSalesOrders(windowDays),
  ]);
  const connected = soReadPathConfigured();

  const open = rows.filter((r) => r.result && SO_CHECK_PROBLEMS.includes(r.result) && !r.resolvedAt);
  const qtyAtRisk = open.reduce((a, r) => a + r.diff.reduce((s, d) => s + Math.abs(d.ourQty - d.wmsQty), 0), 0);
  const valueAtRisk = open.reduce((a, r) => a + r.valueAtRisk, 0);
  const matched = rows.filter((r) => r.result === "MATCHED").length;
  // SO exists but hasn't dispatched, so its quantities aren't in the Outward LOI yet.
  const pendingQty = rows.filter((r) => r.result === "QTY_UNVERIFIED").length;
  const awaiting = rows.filter((r) => !r.result).length;

  return (
    <>
      <Topbar
        title="SO Entry Check"
        subtitle="Portal PO vs the sales order punched into WMS — matched on quantity, SKU-wise"
      />
      <main className="flex-1 space-y-6 px-5 py-6 lg:px-8">
        {!connected && (
          <Card className="border-[hsl(38_92%_50%/0.4)] bg-[hsl(38_92%_50%/0.08)]">
            <CardContent className="space-y-1 p-4 text-sm">
              <p className="font-semibold">SO read-back not connected — nothing is being verified yet.</p>
              <p className="text-muted-foreground">
                Set <code>WMS_EMAIL</code> / <code>WMS_PASSWORD</code> to let the check read sales
                orders from the WMS portal. Until then this page shows approved POs with no verdict,
                and nothing is flagged as missing.
              </p>
            </CardContent>
          </Card>
        )}

        {connected && pendingQty > 0 && (
          <Card className="border-[hsl(224_76%_58%/0.35)] bg-[hsl(224_76%_58%/0.07)]">
            <CardContent className="p-4 text-sm text-muted-foreground">
              <strong className="text-foreground">
                {pendingQty} {pendingQty === 1 ? "SO is" : "SOs are"} punched but not dispatched yet
              </strong>{" "}
              — shown as &ldquo;SO found&rdquo;. Line quantities come from the WMS Outward LOI
              Report, which only lists dispatched orders, so those rows verify SKU-wise on the
              daily pass after they ship. Missing SOs, untraceable references and duplicates are
              checked every hour regardless.
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Open flags"
            value={formatNumber(open.length)}
            hint={
              qtyAtRisk > 0
                ? `${formatNumber(qtyAtRisk)} units off · ${formatINR(valueAtRisk)} at stake`
                : "missing SOs, untraceable refs, duplicates"
            }
            icon={AlertTriangle}
            accent="danger"
          />
          <StatCard
            label="Matched"
            value={formatNumber(matched)}
            hint={
              pendingQty > 0
                ? `of ${rows.length} in ${windowDays}d · ${pendingQty} awaiting dispatch`
                : `of ${rows.length} approved POs in ${windowDays}d`
            }
            icon={CheckCheck}
            accent="mint"
          />
          <StatCard
            label="Awaiting punch"
            value={formatNumber(awaiting)}
            hint={`no SO yet, still inside the ${env.SO_MISSING_SLA_HOURS}h window`}
            icon={ClipboardX}
            accent="lav"
          />
          <StatCard
            label="Last checked"
            value={lastCheckedAt ? relativeTime(lastCheckedAt) : "never"}
            hint={connected ? "runs hourly, 09:00–21:00 IST" : "idle — WMS credentials not set"}
            icon={Hash}
            accent="lime"
          />
        </div>

        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Approved POs · last {windowDays} days</CardTitle>
            <p className="text-xs text-muted-foreground">
              Quantity only, SKU-wise — both PO numbers must also appear on the SO. A split punch
              across several SOs is valid and sums. Flags clear on their own once the warehouse
              team fixes the SO in WMS.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <SoCheckTable rows={rows} />
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>WMS sales orders with no matching PO · {unmatched.length}</CardTitle>
            <p className="text-xs text-muted-foreground">
              Punched in the WMS but carrying no reference we could tie to an approved PO —
              either the reference isn&apos;t one of ours, or the PO never reached the portal.
              Stock transfers and non-channel orders legitimately live here too.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <UnmatchedSoTable rows={unmatched} />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
