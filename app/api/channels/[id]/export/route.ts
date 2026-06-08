import { NextResponse } from "next/server";
import { getChannel } from "@/lib/channels";
import { buildOrdersExport, xlsxResponse } from "@/lib/services/excel-export";

export const dynamic = "force-dynamic";

// Note: the dynamic segment is named `id` to match the sibling /api/channels/[id]
// route (Next forbids two different param names at the same path). The value here
// is the channel SLUG (e.g. "blinkit"), as called by the channel dashboard.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const channel = getChannel(params.id);
  if (!channel) {
    return NextResponse.json({ success: false, error: "Unknown channel" }, { status: 404 });
  }
  const buf = await buildOrdersExport(channel.source);
  const date = new Date().toISOString().slice(0, 10);
  return xlsxResponse(buf, `moxie-${channel.slug}-orders-${date}.xlsx`);
}
