import { Suspense } from "react";
import { Package, IndianRupee, ClipboardList, AlertTriangle } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/dashboard/summary-stats";
import { PoTable } from "@/components/dashboard/po-table";
import { AtpSidebar } from "@/components/dashboard/atp-sidebar";
import { getDashboardData } from "@/lib/data/queries";
import { getLiveAtp } from "@/lib/services/live-atp";
import { formatINR } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return (
    <>
      <Topbar
        title="Morning dashboard"
        subtitle="All purchase orders, prioritised by urgency"
      />
      <main className="flex-1 px-5 py-6 lg:px-8">
        <Suspense fallback={<DashboardSkeleton />}>
          <DashboardContent />
        </Suspense>
      </main>
    </>
  );
}

async function DashboardContent() {
  const [data, atp] = await Promise.all([getDashboardData(), getLiveAtp()]);

  const { summary } = data;
  const delta = summary.todayCount - summary.yesterdayCount;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="POs today"
          value={String(summary.todayCount)}
          icon={Package}
          accent="lime"
          trend={
            summary.yesterdayCount > 0
              ? { value: `${Math.abs(delta)} vs yest`, positive: delta >= 0 }
              : null
          }
        />
        <StatCard
          label="Order value today"
          value={formatINR(summary.todayValue)}
          icon={IndianRupee}
          accent="mint"
        />
        <StatCard
          label="Awaiting allocation"
          value={String(summary.awaitingAllocation)}
          icon={ClipboardList}
          accent="lav"
          hint="Set priorities, then allocate"
        />
        <StatCard
          label="Open discrepancies"
          value={String(summary.openDiscrepancies)}
          icon={AlertTriangle}
          accent={summary.openDiscrepancies > 0 ? "danger" : "lav"}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_320px]">
        <Card className="overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle>Purchase orders</CardTitle>
          </CardHeader>
          <PoTable pos={data.pos} showAllocateCta={data.allPrioritised} />
        </Card>

        <div className="hidden xl:block">
          <AtpSidebar initial={atp} />
        </div>
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="p-5">
            <Skeleton className="h-10 w-10 rounded-xl" />
            <Skeleton className="mt-4 h-7 w-24" />
            <Skeleton className="mt-2 h-4 w-32" />
          </Card>
        ))}
      </div>
      <Card className="p-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="mb-3 h-12 w-full" />
        ))}
      </Card>
    </div>
  );
}
