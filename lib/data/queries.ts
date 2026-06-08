import "server-only";
import { prisma } from "@/lib/db";

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
      channel: { select: { name: true, logoColor: true } },
      lineItems: { select: { requestedQty: true, approvedQty: true } },
    },
  });
  return pos.map((p) => {
    const ordered = p.lineItems.reduce((s, l) => s + l.requestedQty, 0);
    const allocated = p.lineItems.reduce((s, l) => s + (l.approvedQty ?? 0), 0);
    const raw = (p.rawData as Record<string, string> | null) ?? {};
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
  return prisma.grnRecord.findMany({
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
        },
      },
      _count: { select: { lineItems: true, discrepancies: true } },
    },
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
