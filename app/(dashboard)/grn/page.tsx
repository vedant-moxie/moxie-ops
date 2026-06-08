import Link from "next/link";
import { Upload, Download } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GrnTable } from "@/components/grn/grn-table";
import { getGrns } from "@/lib/data/queries";

export const dynamic = "force-dynamic";

export default async function GrnPage() {
  const grns = await getGrns();
  return (
    <>
      <Topbar title="Goods Received Notes" subtitle="Reconciliation status across all channels" />
      <main className="flex-1 px-5 py-6 lg:px-8">
        <Card className="overflow-hidden">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>All GRNs</CardTitle>
            <div className="flex items-center gap-2">
              <Button asChild size="sm" variant="outline">
                <a href="/api/grn/export"><Download className="h-4 w-4" /> Download Excel</a>
              </Button>
              <Button asChild size="sm">
                <Link href="/grn/upload"><Upload className="h-4 w-4" /> Upload CSV</Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <GrnTable grns={grns} />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
