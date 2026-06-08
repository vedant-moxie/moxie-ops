import { Download } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PoTable } from "@/components/dashboard/po-table";
import { getOrders } from "@/lib/data/queries";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const orders = await getOrders();
  return (
    <>
      <Topbar title="Orders" subtitle="Full purchase-order pipeline" />
      <main className="flex-1 px-5 py-6 lg:px-8">
        <div className="mb-4 flex justify-end">
          <Button asChild size="sm" variant="outline">
            <a href="/api/orders/export"><Download className="h-4 w-4" /> Download Excel</a>
          </Button>
        </div>
        <Card className="overflow-hidden pt-4">
          <PoTable pos={orders} />
        </Card>
      </main>
    </>
  );
}
