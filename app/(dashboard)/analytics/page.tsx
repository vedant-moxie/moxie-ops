import { Percent, Target, ShieldCheck, Package } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { StatCard } from "@/components/dashboard/summary-stats";
import { AnalyticsCharts } from "@/components/analytics/charts";
import { InventoryCoverTable } from "@/components/analytics/inventory-cover-table";
import { computeKpis } from "@/lib/services/analytics";
import { computeInventoryCover } from "@/lib/services/inventory-cover";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { pct } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const [kpis, coverRows] = await Promise.all([computeKpis(), computeInventoryCover()]);
  const net = kpis.summary.netFillRate;
  return (
    <>
      <Topbar title="Analytics" subtitle="Operational KPIs · last 30 days" />
      <main className="flex-1 space-y-6 px-5 py-6 lg:px-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Gross fill rate" value={pct(kpis.summary.grossFillRate)} icon={Percent} accent="lime" />
          <StatCard label="Net fill rate" value={net != null ? pct(net) : "—"} icon={Target} accent="mint" />
          <StatCard label="GRN acceptance" value={pct(kpis.summary.acceptanceRate)} icon={ShieldCheck} accent="lav" />
          <StatCard label="Orders this month" value={String(kpis.summary.ordersThisMonth)} icon={Package} accent="lav" />
        </div>
        <AnalyticsCharts data={kpis} />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Inventory Cover · SOH vs Daily Run Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <InventoryCoverTable rows={coverRows} />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
