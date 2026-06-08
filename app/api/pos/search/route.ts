import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { ok, handler } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handler("GET /api/pos/search", async () => {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") ?? "").trim();

    if (q.length < 2) {
      return ok([]);
    }

    const pos = await prisma.purchaseOrder.findMany({
      where: {
        channelPoNumber: { contains: q, mode: "insensitive" },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        channelPoNumber: true,
        status: true,
        channel: { select: { name: true, logoColor: true } },
      },
    });

    return ok(pos);
  });
}
