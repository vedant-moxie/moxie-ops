import "server-only";
import { prisma } from "@/lib/db";
import { computeFillRates } from "@/lib/services/fill-rate";

const DAY = 86_400_000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const pct1 = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 1000) / 10 : null;

export interface Kpis {
  summary: {
    grossFillRate: number;
    netFillRate: number | null;
    acceptanceRate: number;
    avgTat: number;
    ordersThisMonth: number;
  };
  /** Per channel: gross (delivered ÷ ordered) + net (delivered ÷ assigned). */
  fillRateByChannel: { channel: string; gross: number; net: number | null }[];
  /** Daily gross fill from GRNs received that day (last 30d). */
  fillRateTrend: { date: string; gross: number | null }[];
  dispatchTat: { date: string; hours: number }[];
  grnAcceptance: { name: string; value: number }[];
  orderVolume: { date: string; count: number }[];
}

type ChannelAgg = { grossNum: number; grossDen: number; netNum: number; netDen: number };

export async function computeKpis(): Promise<Kpis> {
  const now = Date.now();
  const since = new Date(now - 30 * DAY);

  const pos = await prisma.purchaseOrder.findMany({
    where: { createdAt: { gte: since } },
    select: {
      createdAt: true,
      approvedAt: true,
      channel: { select: { name: true } },
      lineItems: { select: { skuId: true, requestedQty: true, approvedQty: true, rawData: true } },
      dispatchRecord: { select: { dispatchedAt: true } },
      grnRecord: {
        select: { status: true, receivedAt: true, lineItems: { select: { skuId: true, receivedQty: true } } },
      },
    },
  });

  // 1. Fill rate (gross + net) by channel, aggregating capped numerators across POs.
  const byChannel = new Map<string, ChannelAgg>();
  // 2. Daily gross fill from GRNs (keyed by GRN receivedAt day).
  const trendByDay = new Map<string, { num: number; den: number }>();

  for (const po of pos) {
    const fill = computeFillRates(
      po.lineItems.map((l) => ({
        skuId: l.skuId,
        requestedQty: l.requestedQty,
        approvedQty: l.approvedQty,
        rawData: l.rawData,
      })),
      po.grnRecord?.lineItems ?? null,
    );
    if (!fill.hasGrn) continue; // fill rate is about delivered goods — skip undelivered POs

    const agg = byChannel.get(po.channel.name) ?? { grossNum: 0, grossDen: 0, netNum: 0, netDen: 0 };
    agg.grossNum += fill.grossNum;
    agg.grossDen += fill.grossDen;
    agg.netNum += fill.netNum;
    agg.netDen += fill.netDen;
    byChannel.set(po.channel.name, agg);

    const d = po.grnRecord?.receivedAt;
    if (d) {
      const k = dayKey(d);
      const t = trendByDay.get(k) ?? { num: 0, den: 0 };
      t.num += fill.grossNum;
      t.den += fill.grossDen;
      trendByDay.set(k, t);
    }
  }

  const fillRateByChannel = [...byChannel.entries()]
    .map(([channel, v]) => ({
      channel,
      gross: pct1(v.grossNum, v.grossDen) ?? 0,
      net: v.netDen > 0 ? pct1(v.netNum, v.netDen) : null,
    }))
    .sort((a, b) => b.gross - a.gross);

  // Fill-rate trend: one point per day in the window (null where no GRNs that day).
  const fillRateTrend: { date: string; gross: number | null }[] = [];
  for (let i = 29; i >= 0; i--) {
    const k = dayKey(new Date(now - i * DAY));
    const t = trendByDay.get(k);
    fillRateTrend.push({ date: k, gross: t ? pct1(t.num, t.den) : null });
  }

  // 3. Dispatch TAT by day (approval → dispatch).
  const tatByDay = new Map<string, number[]>();
  for (const po of pos) {
    if (po.approvedAt && po.dispatchRecord?.dispatchedAt) {
      const hours = (po.dispatchRecord.dispatchedAt.getTime() - po.approvedAt.getTime()) / 3_600_000;
      if (hours >= 0) {
        const k = dayKey(po.dispatchRecord.dispatchedAt);
        (tatByDay.get(k) ?? tatByDay.set(k, []).get(k)!).push(hours);
      }
    }
  }
  const dispatchTat = [...tatByDay.entries()].sort().map(([date, hrs]) => ({
    date,
    hours: Math.round((hrs.reduce((s, h) => s + h, 0) / hrs.length) * 10) / 10,
  }));

  // 4. GRN acceptance
  let autoAccepted = 0, flagged = 0, resolved = 0;
  for (const po of pos) {
    const s = po.grnRecord?.status;
    if (s === "ACCEPTED") autoAccepted++;
    else if (s === "DISCREPANCY_FLAGGED") flagged++;
    else if (s === "RESOLVED") resolved++;
  }
  const grnAcceptance = [
    { name: "Auto-accepted", value: autoAccepted },
    { name: "Discrepancy flagged", value: flagged },
    { name: "Manually resolved", value: resolved },
  ];

  // 5. Order volume trend
  const volumeByDay = new Map<string, number>();
  for (let i = 29; i >= 0; i--) volumeByDay.set(dayKey(new Date(now - i * DAY)), 0);
  for (const po of pos) {
    const k = dayKey(po.createdAt);
    if (volumeByDay.has(k)) volumeByDay.set(k, (volumeByDay.get(k) ?? 0) + 1);
  }
  const orderVolume = [...volumeByDay.entries()].map(([date, count]) => ({ date, count }));

  // Summary
  const totals = [...byChannel.values()].reduce(
    (s, v) => ({
      grossNum: s.grossNum + v.grossNum,
      grossDen: s.grossDen + v.grossDen,
      netNum: s.netNum + v.netNum,
      netDen: s.netDen + v.netDen,
    }),
    { grossNum: 0, grossDen: 0, netNum: 0, netDen: 0 },
  );
  const grossFillRate = pct1(totals.grossNum, totals.grossDen) ?? 0;
  const netFillRate = totals.netDen > 0 ? pct1(totals.netNum, totals.netDen) : null;

  const allTat = [...tatByDay.values()].flat();
  const avgTat = allTat.length ? Math.round((allTat.reduce((s, h) => s + h, 0) / allTat.length) * 10) / 10 : 0;
  const grnTotal = autoAccepted + flagged + resolved;
  const acceptanceRate = grnTotal ? Math.round(((autoAccepted + resolved) / grnTotal) * 1000) / 10 : 0;

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const ordersThisMonth = await prisma.purchaseOrder.count({ where: { createdAt: { gte: startOfMonth } } });

  return {
    summary: { grossFillRate, netFillRate, acceptanceRate, avgTat, ordersThisMonth },
    fillRateByChannel,
    fillRateTrend,
    dispatchTat,
    grnAcceptance,
    orderVolume,
  };
}
