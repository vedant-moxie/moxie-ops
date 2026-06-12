import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { resolveFields } from "@/lib/integrations/blinkit/fields";
import { resolveInternalSku } from "@/lib/services/sku-resolver";

const DAY = 86_400_000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

function readMoneyProto(raw: Record<string, unknown>, field: string): number | null {
  const m = raw[field];
  if (!m || typeof m !== "object") return null;
  const mo = m as { units?: number; nanos?: number };
  const v = (mo.units ?? 0) + (mo.nanos ?? 0) / 1e9;
  return v > 0 ? v : null;
}

export interface BlinkitPoItem {
  itemId: string;
  /** Internal/master SKU code resolved from the platform id; falls back to the
   *  raw platform id when the SKU isn't mapped yet. Use this for display. */
  displaySkuCode: string;
  upc: string | null;
  name: string;
  uom: string | null;
  ordered: number;
  received: number | null;
  unitPrice: number | null;
  value: number | null;
}
export interface BlinkitPoRow {
  id: string;
  poNumber: string | null;
  poDate: Date | null;
  deliveryDate: Date | null;
  status: PoStatusLite;
  rawStatus: string | null;
  outlet: string | null;
  city: string | null;
  lineCount: number;
  units: number;
  value: number | null;
  raw: Record<string, string>;
  items: BlinkitPoItem[];
}
type PoStatusLite = string;

export interface ChannelInsights {
  days: number;
  hasData: boolean;
  lastSyncedAt: Date | null;
  intervalHours: number;
  headers: string[];
  summary: {
    poCount: number;
    lineCount: number;
    totalUnits: number;
    totalValue: number;
    distinctItems: number;
    distinctOutlets: number;
    avgLinesPerPo: number;
  };
  byDay: { date: string; pos: number; units: number; value: number }[];
  topItems: { code: string; name: string; units: number; value: number; pos: number }[];
  byOutlet: { outlet: string; pos: number; units: number; value: number }[];
  byStatus: { status: string; count: number }[];
  pos: BlinkitPoRow[];
}

/** Back-compat alias — the type was Blinkit-specific before channels were generalized. */
export type BlinkitInsights = ChannelInsights;

function pick(raw: Record<string, string>, header: string | undefined): string | null {
  if (!header) return null;
  const v = raw[header];
  return v && String(v).trim() ? String(v).trim() : null;
}

/** Per-channel auto-sync cadence, read from the channel's env key (falls back to Blinkit's default). */
function intervalHoursFor(source: string): number {
  switch (source) {
    case "ZEPTO":
      return env.ZEPTO_SYNC_INTERVAL_HOURS;
    case "BLINKIT":
    default:
      return env.BLINKIT_SYNC_INTERVAL_HOURS;
  }
}

export async function computeChannelInsights({
  source,
  days = 7,
}: {
  source: string;
  /** Channel slug — accepted for callsite clarity; the source filter is what scopes the query. */
  slug?: string;
  days?: number;
}): Promise<ChannelInsights> {
  const since = new Date(Date.now() - days * DAY);

  const pos = await prisma.purchaseOrder.findMany({
    where: {
      source,
      OR: [{ poDate: { gte: since } }, { AND: [{ poDate: null }, { createdAt: { gte: since } }] }],
    },
    orderBy: [{ poDate: "desc" }, { createdAt: "desc" }],
    include: {
      lineItems: {
        orderBy: { requestedQty: "desc" },
        select: {
          skuId: true,
          channelSkuCode: true,
          requestedQty: true,
          unitPrice: true,
          rawData: true,
          sku: { select: { internalCode: true, name: true, uom: true } },
        },
      },
      grnRecord: { select: { lineItems: { select: { skuId: true, receivedQty: true } } } },
    },
  });

  const headerSet = new Set<string>();
  const rows: BlinkitPoRow[] = [];

  const byDay = new Map<string, { pos: number; units: number; value: number }>();
  const itemAgg = new Map<string, { code: string; name: string; units: number; value: number; pos: Set<string> }>();
  const outletAgg = new Map<string, { pos: number; units: number; value: number }>();
  const statusAgg = new Map<string, number>();

  let totalUnits = 0;
  let totalValue = 0;
  let lineCount = 0;

  for (const po of pos) {
    const raw = (po.rawData as Record<string, string> | null) ?? {};
    Object.keys(raw).forEach((k) => headerSet.add(k));
    const fm = resolveFields(Object.keys(raw));
    const outlet = pick(raw, fm.facility);
    const city = pick(raw, fm.city);
    const rawStatus = pick(raw, fm.status);

    const units = po.lineItems.reduce((s, l) => s + l.requestedQty, 0);
    const value = po.totalRequestedValue ?? 0;
    totalUnits += units;
    totalValue += value;
    lineCount += po.lineItems.length;

    const dk = dayKey(po.poDate ?? po.createdAt);
    const d = byDay.get(dk) ?? { pos: 0, units: 0, value: 0 };
    d.pos++; d.units += units; d.value += value;
    byDay.set(dk, d);

    const outletKey = outlet ?? city ?? "Unspecified";
    const o = outletAgg.get(outletKey) ?? { pos: 0, units: 0, value: 0 };
    o.pos++; o.units += units; o.value += value;
    outletAgg.set(outletKey, o);

    statusAgg.set(rawStatus ?? "—", (statusAgg.get(rawStatus ?? "—") ?? 0) + 1);

    const receivedBySku = new Map(
      (po.grnRecord?.lineItems ?? []).map((g) => [g.skuId, g.receivedQty]),
    );

    const items: BlinkitPoRow["items"] = [];
    for (const l of po.lineItems) {
      const code = l.sku.internalCode;
      const lraw = (l.rawData as Record<string, unknown> | null) ?? {};

      const rawTotalAmount = lraw.total_amount;
      // Instamart stores line prices as Money proto objects. Despite the name,
      // "unit_cost_price_*" holds the LINE TOTAL (confirmed: sum = PO totalRequestedValue).
      const instamartLineTotal = readMoneyProto(lraw, "unit_cost_price_including_tax");
      const instamartLineExcl = readMoneyProto(lraw, "unit_cost_price_excluding_tax");

      const lineValue =
        (rawTotalAmount != null ? Number(String(rawTotalAmount).replace(/[^0-9.]/g, "")) : 0) ||
        (l.unitPrice != null ? l.unitPrice * l.requestedQty : 0) ||
        instamartLineTotal ||
        null;

      // Per-unit price: prefer stored unitPrice, fall back to Instamart excl-tax line total ÷ qty
      const derivedUnitPrice =
        l.unitPrice ??
        (instamartLineExcl != null && l.requestedQty > 0
          ? Math.round((instamartLineExcl / l.requestedQty) * 100) / 100
          : null);

      const uomRaw = lraw.uom_text ?? lraw.unit_of_measurement ?? null;

      const a = itemAgg.get(code) ?? { code, name: l.sku.name, units: 0, value: 0, pos: new Set<string>() };
      a.units += l.requestedQty;
      a.value += lineValue ?? (derivedUnitPrice ?? 0) * l.requestedQty;
      a.pos.add(po.id);
      itemAgg.set(code, a);

      items.push({
        itemId: l.channelSkuCode ?? l.sku.internalCode,
        displaySkuCode: resolveInternalSku(source, l.channelSkuCode ?? l.sku.internalCode),
        upc: typeof lraw.upc === "string" ? lraw.upc : null,
        name: l.sku.name,
        uom: (typeof uomRaw === "string" ? uomRaw : null) ?? l.sku.uom ?? null,
        ordered: l.requestedQty,
        received: receivedBySku.get(l.skuId) ?? null,
        unitPrice: derivedUnitPrice,
        value: lineValue,
      });
    }

    rows.push({
      id: po.id,
      poNumber: po.channelPoNumber,
      poDate: po.poDate,
      deliveryDate: po.requestedDeliveryDate,
      status: po.status,
      rawStatus,
      outlet,
      city,
      lineCount: po.lineItems.length,
      units,
      value: po.totalRequestedValue,
      raw,
      items,
    });
  }

  // fill empty days across the window
  const byDayArr: { date: string; pos: number; units: number; value: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(new Date(Date.now() - i * DAY));
    const v = byDay.get(k) ?? { pos: 0, units: 0, value: 0 };
    byDayArr.push({ date: k, ...v });
  }

  const topItems = [...itemAgg.values()]
    .map((a) => ({ code: a.code, name: a.name, units: a.units, value: a.value, pos: a.pos.size }))
    .sort((a, b) => b.value - a.value || b.units - a.units)
    .slice(0, 12);

  const byOutlet = [...outletAgg.entries()]
    .map(([outlet, v]) => ({ outlet, ...v }))
    .sort((a, b) => b.value - a.value);

  const byStatus = [...statusAgg.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  const latest = await prisma.purchaseOrder.findFirst({
    where: { source },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });

  return {
    days,
    hasData: pos.length > 0,
    lastSyncedAt: latest?.updatedAt ?? null,
    intervalHours: intervalHoursFor(source),
    headers: [...headerSet],
    summary: {
      poCount: pos.length,
      lineCount,
      totalUnits,
      totalValue,
      distinctItems: itemAgg.size,
      distinctOutlets: outletAgg.size,
      avgLinesPerPo: pos.length ? Math.round((lineCount / pos.length) * 10) / 10 : 0,
    },
    byDay: byDayArr,
    topItems,
    byOutlet,
    byStatus,
    pos: rows,
  };
}

/** Thin back-compat wrapper — scopes insights to the Blinkit source. */
export async function computeBlinkitInsights(days = 7): Promise<ChannelInsights> {
  return computeChannelInsights({ source: "BLINKIT", slug: "blinkit", days });
}
