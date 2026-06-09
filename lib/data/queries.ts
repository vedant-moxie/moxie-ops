import "server-only";
import { prisma } from "@/lib/db";
import { validatePoTaxables } from "@/lib/services/taxable-validation";
import { computeFillRates } from "@/lib/services/fill-rate";
import { currentActor } from "@/lib/auth";
import { isClaimedByOther } from "@/lib/services/po-claim";

const DAY = 86_400_000;

/** Counts used for sidebar badges. */
export async function getNavCounts() {
  const [pendingPos, openDiscrepancies] = await Promise.all([
    prisma.purchaseOrder.count({
      where: { status: { in: ["PENDING_REVIEW", "PRIORITISED"] } },
    }),
    prisma.discrepancy.count({ where: { status: { in: ["OPEN", "DISPUTED"] } } }),
  ]);
  return { pendingPos, openDiscrepancies };
}

/** Morning-dashboard summary cards + PO list. */
export async function getDashboardData() {
  const now = Date.now();
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const startYesterday = new Date(startToday.getTime() - DAY);

  const [todayPos, yesterdayPos, awaitingAllocation, openDiscrepancies, pos] =
    await Promise.all([
      prisma.purchaseOrder.findMany({
        where: { createdAt: { gte: startToday } },
        select: { totalRequestedValue: true },
      }),
      prisma.purchaseOrder.count({
        where: { createdAt: { gte: startYesterday, lt: startToday } },
      }),
      prisma.purchaseOrder.count({
        where: { status: { in: ["PENDING_REVIEW", "PRIORITISED"] } },
      }),
      prisma.discrepancy.count({ where: { status: { in: ["OPEN", "DISPUTED"] } } }),
      prisma.purchaseOrder.findMany({
        orderBy: [{ priorityScore: "desc" }, { createdAt: "desc" }],
        take: 500,
        select: {
          id: true,
          channelPoNumber: true,
          status: true,
          priority: true,
          priorityScore: true,
          totalRequestedValue: true,
          requestedDeliveryDate: true,
          poDate: true,
          createdAt: true,
          channel: { select: { id: true, name: true, logoColor: true, tier: true } },
          _count: { select: { lineItems: true } },
        },
      }),
    ]);

  const todayValue = todayPos.reduce((s, p) => s + (p.totalRequestedValue ?? 0), 0);
  const allPrioritised = pos
    .filter((p) => p.status === "PENDING_REVIEW" || p.status === "PRIORITISED")
    .every((p) => !!p.priority);

  return {
    summary: {
      todayCount: todayPos.length,
      yesterdayCount: yesterdayPos,
      todayValue,
      awaitingAllocation,
      openDiscrepancies,
    },
    pos,
    allPrioritised,
  };
}

/** POs awaiting allocation + their line items (for the grid). */
export async function getAllocationData() {
  const pos = await prisma.purchaseOrder.findMany({
    where: { status: { in: ["PENDING_REVIEW", "PRIORITISED", "ALLOCATED"] } },
    orderBy: [{ priorityScore: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      channelPoNumber: true,
      priority: true,
      priorityScore: true,
      status: true,
      totalRequestedValue: true,
      channel: { select: { id: true, name: true, logoColor: true, tier: true } },
      lineItems: {
        select: {
          id: true,
          skuId: true,
          requestedQty: true,
          approvedQty: true,
          sku: { select: { internalCode: true, name: true, casePackSize: true } },
        },
      },
    },
  });
  return pos;
}

/** Lightweight list of POs to allocate (open / partially received). */
export async function getAllocationList() {
  const actor = await currentActor();
  const pos = await prisma.purchaseOrder.findMany({
    where: { status: { in: ["PENDING_REVIEW", "PRIORITISED", "ALLOCATED", "GRN_RECEIVED"] } },
    orderBy: [{ poDate: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      channelPoNumber: true,
      status: true,
      poDate: true,
      totalRequestedValue: true,
      rawData: true,
      claimedById: true,
      claimedByLabel: true,
      claimedAt: true,
      channel: { select: { name: true, logoColor: true } },
      lineItems: {
        select: {
          id: true,
          skuId: true,
          requestedQty: true,
          approvedQty: true,
          channelSkuCode: true,
          unitPrice: true,
          rawData: true,
          sku: { select: { internalCode: true, name: true } },
        },
      },
    },
  });
  return pos.map((p) => {
    const ordered = p.lineItems.reduce((s, l) => s + l.requestedQty, 0);
    const allocated = p.lineItems.reduce((s, l) => s + (l.approvedQty ?? 0), 0);
    const raw = (p.rawData as Record<string, string> | null) ?? {};
    const taxResult = validatePoTaxables(p);
    // Join validation results back to skuId/name for the bulk review modal.
    const lineById = new Map(p.lineItems.map((l) => [l.id, l]));
    const unmappedSkus = taxResult.lines
      .filter((l) => l.unmapped)
      .map((l) => {
        const li = lineById.get(l.lineId);
        return { skuId: li?.skuId ?? "", channelSkuCode: l.channelSkuCode, name: li?.sku.name ?? l.sku };
      })
      .filter((l) => l.skuId);
    const priceMismatches = taxResult.lines
      .filter((l) => l.mismatch)
      .map((l) => {
        const li = lineById.get(l.lineId);
        return {
          skuId: li?.skuId ?? "",
          channelSkuCode: l.channelSkuCode,
          name: li?.sku.name ?? l.sku,
          expected: l.expected,
          actual: l.actual,
        };
      });
    return {
      id: p.id,
      channelPoNumber: p.channelPoNumber,
      status: p.status,
      poDate: p.poDate,
      totalRequestedValue: p.totalRequestedValue,
      channel: p.channel,
      facility: raw.facility_name ?? raw.facility ?? null,
      skuCount: p.lineItems.length,
      orderedUnits: ordered,
      allocatedUnits: allocated,
      hasTaxableMismatch: taxResult.hasTaxableMismatch,
      taxMismatchCount: priceMismatches.length,
      hasUnmappedSku: taxResult.hasUnmappedSku,
      unmappedSkus,
      priceMismatches,
      // Allocation lock: is another user actively working this PO?
      lockedByOther: isClaimedByOther(p, actor.id),
      claimedByLabel: p.claimedByLabel,
    };
  });
}

export async function getPoForAllocation(id: string) {
  return prisma.purchaseOrder.findUnique({
    where: { id },
    select: {
      id: true,
      channelPoNumber: true,
      status: true,
      poDate: true,
      requestedDeliveryDate: true,
      totalRequestedValue: true,
      rawData: true,
      claimedById: true,
      claimedByLabel: true,
      claimedAt: true,
      channel: { select: { name: true, logoColor: true, tier: true } },
      lineItems: {
        orderBy: { requestedQty: "desc" },
        select: {
          id: true,
          skuId: true,
          channelSkuCode: true,
          requestedQty: true,
          approvedQty: true,
          unitPrice: true,
          rawData: true,
          sku: { select: { internalCode: true, name: true, uom: true } },
        },
      },
      grnRecord: { select: { lineItems: { select: { skuId: true, receivedQty: true } } } },
    },
  });
}

export async function getOrders() {
  return prisma.purchaseOrder.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      channelPoNumber: true,
      status: true,
      priority: true,
      priorityScore: true,
      totalRequestedValue: true,
      requestedDeliveryDate: true,
      poDate: true,
      createdAt: true,
      channel: { select: { id: true, name: true, logoColor: true, tier: true } },
      _count: { select: { lineItems: true } },
    },
  });
}

export async function getChannels() {
  return prisma.channel.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { purchaseOrders: true, channelSkus: true } } },
  });
}

export async function getSkus() {
  return prisma.sku.findMany({ orderBy: { internalCode: "asc" } });
}

export async function getGrns() {
  const records = await prisma.grnRecord.findMany({
    orderBy: { receivedAt: "desc" },
    select: {
      id: true,
      source: true,
      channelGrnNumber: true,
      status: true,
      receivedAt: true,
      totalAcceptedValue: true,
      po: {
        select: {
          id: true,
          channelPoNumber: true,
          channel: { select: { name: true, logoColor: true } },
          lineItems: {
            select: {
              skuId: true,
              requestedQty: true,
              approvedQty: true,
              rawData: true,
              sku: { select: { internalCode: true, name: true } },
            },
          },
        },
      },
      lineItems: {
        select: {
          skuId: true,
          receivedQty: true,
          sku: { select: { internalCode: true, name: true } },
        },
      },
      _count: { select: { lineItems: true } },
    },
  });

  return records.map((r) => {
    const orderedBySku = new Map(
      r.po.lineItems.map((l) => [l.skuId, { qty: l.requestedQty, sku: l.sku }]),
    );
    const receivedBySku = new Map(
      r.lineItems.map((l) => [l.skuId, { qty: l.receivedQty, sku: l.sku }]),
    );

    const totalOrdered = r.po.lineItems.reduce((s, l) => s + l.requestedQty, 0);
    const totalReceived = r.lineItems.reduce((s, l) => s + l.receivedQty, 0);
    const fillRatePct = totalOrdered > 0 ? Math.round((totalReceived / totalOrdered) * 100) : 0;
    // Net fill = delivered ÷ assigned (team allocation or scraped ASN); null when none.
    const fill = computeFillRates(
      r.po.lineItems.map((l) => ({
        skuId: l.skuId,
        requestedQty: l.requestedQty,
        approvedQty: l.approvedQty,
        rawData: l.rawData,
      })),
      r.lineItems.map((l) => ({ skuId: l.skuId, receivedQty: l.receivedQty })),
    );
    const netFillPct = fill.netPct;

    const allSkuIds = new Set([...orderedBySku.keys(), ...receivedBySku.keys()]);
    const variances: Array<{
      internalCode: string;
      name: string;
      ordered: number;
      received: number;
      variance: number;
    }> = [];

    for (const skuId of allSkuIds) {
      const ordered = orderedBySku.get(skuId)?.qty ?? 0;
      const received = receivedBySku.get(skuId)?.qty ?? 0;
      if (received !== ordered) {
        const skuInfo = orderedBySku.get(skuId)?.sku ?? receivedBySku.get(skuId)?.sku;
        variances.push({
          internalCode: skuInfo?.internalCode ?? skuId,
          name: skuInfo?.name ?? skuId,
          ordered,
          received,
          variance: received - ordered,
        });
      }
    }

    return {
      id: r.id,
      source: r.source,
      channelGrnNumber: r.channelGrnNumber,
      status: r.status,
      receivedAt: r.receivedAt,
      totalAcceptedValue: r.totalAcceptedValue,
      po: { id: r.po.id, channelPoNumber: r.po.channelPoNumber, channel: r.po.channel },
      _count: { lineItems: r._count.lineItems },
      totalOrdered,
      totalReceived,
      fillRatePct,
      netFillPct,
      isPerfect: variances.length === 0,
      discrepancyCount: variances.length,
      variances,
    };
  });
}

export async function getOpenDiscrepancies() {
  return prisma.discrepancy.findMany({
    where: { status: { in: ["OPEN", "DISPUTED"] } },
    orderBy: { createdAt: "asc" },
    include: {
      sku: true,
      grnRecord: {
        select: {
          id: true,
          channelGrnNumber: true,
          po: {
            select: {
              id: true,
              channelPoNumber: true,
              channel: { select: { name: true, logoColor: true } },
            },
          },
        },
      },
    },
  });
}
