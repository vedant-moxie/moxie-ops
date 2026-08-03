import "server-only";
import { prisma } from "@/lib/db";
import { ensureSkuMasterFresh } from "@/lib/services/sku-master";
import { validatePoTaxables } from "@/lib/services/taxable-validation";
import { computeFillRates } from "@/lib/services/fill-rate";
import { grnPortalUrl } from "@/lib/services/portal-links";
import { currentActor } from "@/lib/auth";
import { isClaimedByOther } from "@/lib/services/po-claim";
import { resolveFields } from "@/lib/integrations/blinkit/fields";
import { normRef } from "@/lib/services/so-verification-helpers";
import { soCheckSortRank } from "@/lib/status";

const DAY = 86_400_000;

/**
 * Resolve a PO's destination facility/outlet from its raw source row.
 * Uses the same fuzzy header resolver as the channel dashboard so the
 * Allocation "Facility" column matches the channel "Outlet" column
 * (Zepto/Nykaa store it under keys like `location`/`warehouse_location`,
 * not the literal `facility_name`/`facility`).
 */
function resolveFacility(raw: Record<string, string>): string | null {
  const fm = resolveFields(Object.keys(raw));
  const pick = (header: string | undefined) => {
    if (!header) return null;
    const v = raw[header];
    return v && String(v).trim() ? String(v).trim() : null;
  };
  return pick(fm.facility) ?? pick(fm.city) ?? null;
}

/** Counts used for sidebar badges. */
export async function getNavCounts() {
  const [pendingPos, openDiscrepancies, openSoChecks] = await Promise.all([
    prisma.purchaseOrder.count({
      where: { status: { in: ["PENDING_REVIEW", "PRIORITISED"] } },
    }),
    prisma.discrepancy.count({ where: { status: { in: ["OPEN", "DISPUTED"] } } }),
    prisma.soCheck.count({
      // QTY_UNVERIFIED is a read-path limit, not a warehouse mistake — never badge it.
      where: { result: { notIn: ["MATCHED", "QTY_UNVERIFIED"] }, resolvedAt: null },
    }),
  ]);
  return { pendingPos, openDiscrepancies, openSoChecks };
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
  await ensureSkuMasterFresh();
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
  await ensureSkuMasterFresh();
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
      facility: resolveFacility(raw),
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
  await ensureSkuMasterFresh();
  return prisma.purchaseOrder.findUnique({
    where: { id },
    select: {
      id: true,
      channelPoNumber: true,
      source: true,
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
      emailRef: true,
      emailStatus: true,
      emailSentAt: true,
      emailSentBy: true,
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


export async function getGrns() {
  await ensureSkuMasterFresh();
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
          source: true,
          rawData: true,
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
      portalUrl: grnPortalUrl(r.po.source, r.po.rawData),
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

/**
 * GRN follow-up view over POs issued from this portal (emailStatus SENT):
 * which have a GRN back (and at what fill rate), and which are still awaiting one.
 */
export async function getIssuedPoGrnStatus() {
  const pos = await prisma.purchaseOrder.findMany({
    // "Issued" = the PO email actually went out. emailSentAt covers POs sent
    // before the emailStatus field existed (those rows still say NOT_SENT).
    where: { OR: [{ emailStatus: "SENT" }, { emailSentAt: { not: null } }] },
    orderBy: { emailSentAt: "desc" },
    select: {
      id: true,
      channelPoNumber: true,
      emailRef: true,
      emailSentAt: true,
      channel: { select: { name: true, logoColor: true } },
      lineItems: { select: { skuId: true, requestedQty: true, approvedQty: true, rawData: true } },
      grnRecord: {
        select: { receivedAt: true, status: true, lineItems: { select: { skuId: true, receivedQty: true } } },
      },
    },
  });

  let grossNum = 0;
  let grossDen = 0;
  let netNum = 0;
  let netDen = 0;
  let grnCount = 0;
  const awaiting: Array<{
    id: string;
    channelPoNumber: string | null;
    emailRef: string | null;
    emailSentAt: Date | null;
    channel: { name: string; logoColor: string | null };
  }> = [];

  for (const po of pos) {
    if (po.grnRecord) {
      grnCount++;
      const fill = computeFillRates(po.lineItems, po.grnRecord.lineItems);
      grossNum += fill.grossNum;
      grossDen += fill.grossDen;
      netNum += fill.netNum;
      netDen += fill.netDen;
    } else {
      awaiting.push({
        id: po.id,
        channelPoNumber: po.channelPoNumber,
        emailRef: po.emailRef,
        emailSentAt: po.emailSentAt,
        channel: po.channel,
      });
    }
  }

  const pct = (num: number, den: number): number | null =>
    den > 0 ? Math.round((num / den) * 1000) / 10 : null;

  // Refs issued whose email never got delivered (HELD/FAILED or legacy) — shown
  // as a hint so the issued count reconciles against the email-ref counter.
  const undeliveredCount = await prisma.purchaseOrder.count({
    where: { emailRef: { not: null }, emailSentAt: null },
  });

  return {
    issuedCount: pos.length,
    undeliveredCount,
    grnCount,
    awaiting,
    grossFillPct: pct(grossNum, grossDen),
    netFillPct: netDen > 0 ? pct(netNum, netDen) : null,
  };
}

const DISCREPANCY_INCLUDE = {
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
} as const;

export async function getOpenDiscrepancies() {
  return prisma.discrepancy.findMany({
    where: { status: { in: ["OPEN", "DISPUTED"] } },
    orderBy: { createdAt: "asc" },
    include: DISCREPANCY_INCLUDE,
  });
}

/** Resolved history for the Reconciliation page (most recent first). */
export async function getResolvedDiscrepancies(limit = 100) {
  return prisma.discrepancy.findMany({
    where: { status: { in: ["ACCEPTED", "DEBIT_NOTE_RAISED", "RESOLVED"] } },
    orderBy: [{ resolvedAt: "desc" }, { createdAt: "desc" }],
    take: limit,
    include: DISCREPANCY_INCLUDE,
  });
}

/** ₹ headline numbers for the Reconciliation page. */
export async function getReconciliationSummary() {
  const IST_OFFSET_MS = 5.5 * 3_600_000;
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  const monthStart = new Date(
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), 1) - IST_OFFSET_MS,
  );

  const [open, disputed, debitNoted, writtenOff] = await Promise.all([
    prisma.discrepancy.aggregate({
      where: { status: "OPEN" },
      _sum: { valueImpact: true },
      _count: true,
    }),
    prisma.discrepancy.aggregate({
      where: { status: "DISPUTED" },
      _sum: { valueImpact: true },
      _count: true,
    }),
    prisma.discrepancy.aggregate({
      where: { status: "DEBIT_NOTE_RAISED", resolvedAt: { gte: monthStart } },
      _sum: { valueImpact: true },
      _count: true,
    }),
    prisma.discrepancy.aggregate({
      where: { status: "ACCEPTED", resolvedAt: { gte: monthStart } },
      _sum: { valueImpact: true },
      _count: true,
    }),
  ]);

  const sum = (a: { _sum: { valueImpact: number | null } }) => a._sum.valueImpact ?? 0;
  return {
    openValue: sum(open),
    openCount: open._count,
    disputedValue: sum(disputed),
    disputedCount: disputed._count,
    debitNotedValue: sum(debitNoted),
    debitNotedCount: debitNoted._count,
    writtenOffValue: sum(writtenOff),
    writtenOffCount: writtenOff._count,
  };
}

/**
 * Tie-out between the Analytics fill-rate gap and Reconciliation (last 30d):
 * of the units ordered-but-not-received, how many are captured as discrepancy
 * rows and how many are unexplained. When `unexplainedUnits` is large, the
 * two screens are disagreeing silently — usually GRNs that predate the
 * baseline fix (run scripts/backfill-discrepancies.ts).
 */
export async function getVarianceTieOut() {
  const since = new Date(Date.now() - 30 * DAY);
  const pos = await prisma.purchaseOrder.findMany({
    where: { grnRecord: { receivedAt: { gte: since } } },
    select: {
      lineItems: {
        select: { skuId: true, requestedQty: true, approvedQty: true, unitPrice: true, rawData: true },
      },
      grnRecord: {
        select: { id: true, lineItems: { select: { skuId: true, receivedQty: true } } },
      },
    },
  });

  let gapUnits = 0;
  let gapValue = 0;
  const grnIds: string[] = [];
  for (const po of pos) {
    if (!po.grnRecord) continue;
    grnIds.push(po.grnRecord.id);
    const fill = computeFillRates(po.lineItems, po.grnRecord.lineItems);
    const priceBySku = new Map(po.lineItems.map((l) => [l.skuId, l.unitPrice ?? 0]));
    for (const line of fill.perLine) {
      const short = Math.max(0, line.ordered - line.received);
      gapUnits += short;
      gapValue += short * (priceBySku.get(line.skuId) ?? 0);
    }
  }

  // Shortage-side discrepancy rows on those same GRNs (any status/origin).
  const explained = await prisma.discrepancy.aggregate({
    where: { grnId: { in: grnIds }, type: { in: ["SHORT_RECEIPT", "CHANNEL_REJECTION"] } },
    _sum: { varianceQty: true },
  });
  const explainedUnits = Math.max(0, explained._sum.varianceQty ?? 0);

  return {
    windowDays: 30,
    gapUnits,
    gapValue,
    explainedUnits,
    unexplainedUnits: Math.max(0, gapUnits - explainedUnits),
  };
}

/**
 * Internal short-ship (last 30d): GRN'd POs where what we committed
 * (allocation/ASN) fell short of the channel's ask beyond tolerance. This is
 * our own warehouse/stock problem — informational, no channel dispute — so it
 * is derived here rather than persisted as Discrepancy rows.
 */
export async function getInternalShortShip() {
  const since = new Date(Date.now() - 30 * DAY);
  const TOLERANCE_PCT = 2.0;
  const pos = await prisma.purchaseOrder.findMany({
    where: { grnRecord: { receivedAt: { gte: since } } },
    select: {
      id: true,
      channelPoNumber: true,
      channel: { select: { name: true, logoColor: true } },
      lineItems: {
        select: {
          skuId: true,
          requestedQty: true,
          approvedQty: true,
          unitPrice: true,
          rawData: true,
          sku: { select: { internalCode: true, name: true } },
        },
      },
      grnRecord: { select: { receivedAt: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const rows: Array<{
    poId: string;
    channelPoNumber: string | null;
    channel: { name: string; logoColor: string | null };
    skuCode: string;
    skuName: string;
    ordered: number;
    committed: number;
    gapQty: number;
    gapValue: number | null;
    receivedAt: Date | null;
  }> = [];

  for (const po of pos) {
    const fill = computeFillRates(po.lineItems, null);
    const bySku = new Map(po.lineItems.map((l) => [l.skuId, l]));
    for (const line of fill.perLine) {
      if (line.assigned == null || line.ordered === 0) continue;
      const gap = line.ordered - line.assigned;
      if (gap <= 0 || (gap / line.ordered) * 100 <= TOLERANCE_PCT) continue;
      const li = bySku.get(line.skuId);
      rows.push({
        poId: po.id,
        channelPoNumber: po.channelPoNumber,
        channel: po.channel,
        skuCode: li?.sku.internalCode ?? line.skuId,
        skuName: li?.sku.name ?? "",
        ordered: line.ordered,
        committed: line.assigned,
        gapQty: gap,
        gapValue: li?.unitPrice != null ? Math.round(gap * li.unitPrice * 100) / 100 : null,
        receivedAt: po.grnRecord?.receivedAt ?? null,
      });
    }
  }

  rows.sort((a, b) => (b.gapValue ?? 0) - (a.gapValue ?? 0));
  return rows;
}

/**
 * SO Entry Check page (plan 008): approved POs in the rolling window with the
 * verdict of the last verification run, the SKU-wise diff, and the SO(s) the
 * warehouse team actually punched.
 *
 * A PO with no SoCheck row is "awaiting punch" — either still inside the missing-SO
 * SLA or never checked. That's deliberately not a flag.
 */
export async function getSoCheckRows(windowDays = 30) {
  const windowStart = new Date(Date.now() - windowDays * DAY);
  const pos = await prisma.purchaseOrder.findMany({
    where: {
      status: { in: ["APPROVED", "DISPATCHED", "DELIVERED", "GRN_RECEIVED", "CLOSED", "DISCREPANCY"] },
      OR: [{ approvedAt: { gte: windowStart } }, { approvedAt: null, updatedAt: { gte: windowStart } }],
    },
    select: {
      id: true,
      channelPoNumber: true,
      emailRef: true,
      approvedAt: true,
      emailSentAt: true,
      status: true,
      channel: { select: { name: true, logoColor: true } },
      soCheck: true,
      lineItems: {
        select: { approvedQty: true, unitPrice: true, sku: { select: { internalCode: true, name: true } } },
      },
    },
    orderBy: [{ approvedAt: "desc" }, { updatedAt: "desc" }],
  });

  const mirrors = pos.length
    ? await prisma.wmsSalesOrderMirror.findMany({ where: { poId: { in: pos.map((p) => p.id) } } })
    : [];
  const mirrorsByPo = new Map<string, typeof mirrors>();
  for (const m of mirrors) {
    if (!m.poId) continue;
    mirrorsByPo.set(m.poId, [...(mirrorsByPo.get(m.poId) ?? []), m]);
  }

  // Unit price per internal code, so a qty diff can be shown in rupees.
  const priceBySku = new Map<string, number>();
  for (const po of pos) {
    for (const l of po.lineItems) {
      if (l.unitPrice != null && !priceBySku.has(l.sku.internalCode)) {
        priceBySku.set(l.sku.internalCode, l.unitPrice);
      }
    }
  }

  const rows = pos.map((po) => {
    const sos = mirrorsByPo.get(po.id) ?? [];
    const diff = (po.soCheck?.diff ?? []) as Array<{ skuCode: string; ourQty: number; wmsQty: number }>;
    const skuNames = new Map(po.lineItems.map((l) => [l.sku.internalCode, l.sku.name]));
    return {
      poId: po.id,
      channel: po.channel,
      channelPoNumber: po.channelPoNumber,
      emailRef: po.emailRef,
      status: po.status,
      approvedAt: po.approvedAt,
      emailSentAt: po.emailSentAt,
      skuCount: po.lineItems.filter((l) => (l.approvedQty ?? 0) > 0).length,
      ourQty: po.soCheck?.ourQty ?? po.lineItems.reduce((a, l) => a + (l.approvedQty ?? 0), 0),
      wmsQty: po.soCheck?.wmsQty ?? null,
      result: po.soCheck?.result ?? null,
      checkedAt: po.soCheck?.checkedAt ?? null,
      resolvedAt: po.soCheck?.resolvedAt ?? null,
      resolvedBy: po.soCheck?.resolvedBy ?? null,
      note: po.soCheck?.note ?? null,
      refs: {
        channelPo: sos.some((s) => matchesRef(s, po.channelPoNumber)),
        mbRef: sos.some((s) => matchesRef(s, po.emailRef)),
      },
      warehouseCode: sos.find((s) => s.warehouseCode)?.warehouseCode ?? null,
      diff: diff.map((d) => ({
        ...d,
        name: skuNames.get(d.skuCode) ?? "",
        valueImpact:
          priceBySku.has(d.skuCode)
            ? Math.round(Math.abs(d.ourQty - d.wmsQty) * priceBySku.get(d.skuCode)! * 100) / 100
            : null,
      })),
      // |qty off| × unit price — what a bad punch puts at risk on this PO.
      valueAtRisk: diff.reduce(
        (a, d) => a + Math.abs(d.ourQty - d.wmsQty) * (priceBySku.get(d.skuCode) ?? 0),
        0,
      ),
      // Party as the WMS records it (Customer Name / KPI "customer") — ops asked for
      // this on the list, since it is how the warehouse identifies a destination.
      party: sos.find((s) => s.customer)?.customer ?? null,
      salesOrders: sos.map((s) => ({
        id: s.wmsSalesOrderId,
        orderNo: s.orderNo,
        refNo: s.refNo,
        partyRefOrderNo: s.partyRefOrderNo,
        orderDate: s.orderDate,
        status: s.status,
        customer: s.customer,
        warehouseCode: s.warehouseCode,
        linesKnown: s.linesKnown,
      })),
    };
  });

  // Worst first, newest first within the same verdict — ops works top-down.
  rows.sort((a, b) => {
    const d = soCheckSortRank(a.result, !!a.resolvedAt) - soCheckSortRank(b.result, !!b.resolvedAt);
    if (d !== 0) return d;
    return (b.approvedAt?.getTime() ?? 0) - (a.approvedAt?.getTime() ?? 0);
  });

  const lastCheckedAt = rows.reduce<Date | null>(
    (a, r) => (r.checkedAt && (!a || r.checkedAt > a) ? r.checkedAt : a),
    null,
  );
  return { rows, lastCheckedAt };
}

/** Does this mirrored SO carry `want` in any of its three reference fields? */
function matchesRef(
  so: { orderNo: string | null; refNo: string | null; partyRefOrderNo: string | null },
  want: string | null,
): boolean {
  return !!normRef(want) && [so.orderNo, so.refNo, so.partyRefOrderNo].some((v) => normRef(v) === normRef(want));
}

export type SoCheckRow = Awaited<ReturnType<typeof getSoCheckRows>>["rows"][number];

/**
 * Sales orders mirrored from the WMS that no approved PO in the window claimed.
 *
 * These are a signal in their own right: an SO whose reference we can't place is one
 * nobody can trace back to a PO (the warehouse team's reference convention), or it
 * belongs to a PO outside the window / not in the portal at all.
 */
export async function getUnmatchedSalesOrders(windowDays = 30, limit = 200) {
  const windowStart = new Date(Date.now() - windowDays * DAY);
  const rows = await prisma.wmsSalesOrderMirror.findMany({
    where: { poId: null, OR: [{ orderDate: { gte: windowStart } }, { orderDate: null }] },
    orderBy: [{ orderDate: "desc" }],
    take: limit,
  });
  return rows.map((m) => {
    const lines = (m.lines ?? []) as Array<{ skuCode: string; qty: number }>;
    return {
      id: m.wmsSalesOrderId,
      orderNo: m.orderNo,
      refNo: m.refNo,
      warehouseCode: m.warehouseCode,
      customer: m.customer,
      orderDate: m.orderDate,
      status: m.status,
      skuCount: lines.length,
      totalQty: lines.reduce((a, l) => a + l.qty, 0),
      linesKnown: m.linesKnown,
    };
  });
}

export type UnmatchedSalesOrder = Awaited<ReturnType<typeof getUnmatchedSalesOrders>>[number];
