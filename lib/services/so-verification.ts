import "server-only";
import { Prisma, type SoCheckResult } from "@prisma/client";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { fetchWmsSalesOrders, wmsConfigured, type WmsSalesOrderRow } from "@/lib/integrations/wms";
import { warehouseByWmsName } from "@/lib/warehouses";
import {
  resolveLineInternalSku,
  resolveInternalSkuAnyChannel,
  pvIdFromRaw,
  eanFromRaw,
} from "@/lib/services/sku-resolver";
import { mapEansToInternal } from "@/lib/services/sku-ean-resolver";
import {
  evaluateSoCheck,
  mergeMirrorFields,
  soMatchesPo,
  type SoLine,
} from "@/lib/services/so-verification-helpers";

/**
 * Verifies the SO the warehouse team punched by hand into the WMS against what we
 * approved on the PO. The compare rules live in so-verification-helpers.ts; this
 * module is the I/O around them — read SOs, match to POs, persist the verdicts.
 *
 * Compares against CURRENT approved quantities always, so PO revisions need nothing
 * more than "update approved qtys, re-run".
 */

export * from "@/lib/services/so-verification-helpers";

// ── Sync + persist ──────────────────────────────────────────────────────────

export interface SoVerificationResult {
  ok: boolean;
  salesOrders: number;
  posChecked: number;
  flagged: number;
  /** Verdicts removed because the PO is no longer judgeable (see the null branch). */
  cleared: number;
  byResult: Partial<Record<SoCheckResult, number>>;
  error?: string;
}

/**
 * PO states where a sales order should already exist in the WMS.
 *
 * ALLOCATED is the important one: allocate-and-email.ts sets status=ALLOCATED (not
 * APPROVED) at the moment the PO-preparation email goes to the warehouse, which is
 * exactly when the punch is expected. APPROVED comes from the separate approve route.
 */
const CHECKED_STATUSES = [
  "ALLOCATED",
  "APPROVED",
  "DISPATCHED",
  "DELIVERED",
  "GRN_RECEIVED",
  "DISCREPANCY",
] as const;

/**
 * CLOSED is deliberately absent (ops decision): the PO is delivered, GRN'd and invoiced,
 * so whether its sales order was punched correctly is settled history. Closed POs must
 * not appear on the SO Entry Check page at all — see the cleanup below, which removes
 * verdicts written before a PO closed so a stale flag can't linger in the sidebar count.
 */
const CLOSED_STATUS = "CLOSED";

/**
 * States where the goods have demonstrably already left. A missing SO here is a gap in
 * our mirror (the SO aged out of the WMS feeds), not a warehouse failure — the stock
 * moved, so flagging it is noise. Quantity and reference checks still run when an SO
 * IS found.
 */
const SHIPPED_STATUSES = new Set(["DISPATCHED", "DELIVERED", "GRN_RECEIVED", "CLOSED"]);

// One run at a time per instance; concurrent callers await the same promise.
let inflight: Promise<SoVerificationResult> | null = null;

/**
 * @param opts.withLines also pull the Outward LOI Report, which carries SKU quantities
 *   but is dispatch-driven and needs a warehouse switch per warehouse. Daily pass only.
 */
export function verifySalesOrders(opts: { withLines?: boolean } = {}): Promise<SoVerificationResult> {
  if (inflight) return inflight;
  inflight = doVerify(opts).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doVerify(opts: { withLines?: boolean }): Promise<SoVerificationResult> {
  const empty = { salesOrders: 0, posChecked: 0, flagged: 0, cleared: 0, byResult: {} };
  if (!wmsConfigured()) {
    return { ok: false, ...empty, error: "WMS_EMAIL / WMS_PASSWORD not set" };
  }

  const windowStart = new Date(Date.now() - env.SO_CHECK_WINDOW_DAYS * 86_400_000);

  // A fetch failure must never wipe mirrors or flip existing checks (plan 007's
  // lesson for the stock mirror) — bail out before touching anything.
  let sos: WmsSalesOrderRow[];
  try {
    sos = await fetchWmsSalesOrders(windowStart, new Date(), { withLines: opts.withLines });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn("[so-check] SO fetch failed — mirrors and flags left untouched:", error);
    return { ok: false, ...empty, error };
  }

  const fetchedAt = new Date();
  const pos = await prisma.purchaseOrder.findMany({
    where: {
      status: { in: [...CHECKED_STATUSES] },
      OR: [
        { emailSentAt: { gte: windowStart } },
        { emailSentAt: null, approvedAt: { gte: windowStart } },
        { emailSentAt: null, approvedAt: null, updatedAt: { gte: windowStart } },
      ],
    },
    select: {
      id: true,
      source: true,
      status: true,
      channelPoNumber: true,
      emailRef: true,
      approvedAt: true,
      emailSentAt: true,
      lineItems: {
        select: {
          approvedQty: true,
          channelSkuCode: true,
          rawData: true,
          sku: { select: { internalCode: true } },
        },
      },
    },
  });

  // Resolve every SO line's SKU the same way the WMS push does, so a code the WH
  // team typed lines up with the code we asked for.
  const fetched = sos.map((so) => ({
    ...so,
    lines: so.lines.map((l) => ({ skuCode: resolveInternalSkuAnyChannel(l.skuCode), qty: l.qty })),
  }));

  // Persist what we just read BEFORE matching, then match against the accumulated
  // mirror rather than this one fetch. The KPI feed only lists SOs that haven't
  // dispatched yet, so an SO drops out of it the moment it ships — matching on the
  // live fetch alone would flip a verified PO back to MISSING_SO on dispatch.
  //
  // Merge against what we already stored so the hourly (header-only) run cannot erase
  // the quantities the daily run collected — see mergeMirrorFields.
  const storedById = new Map(
    (
      await prisma.wmsSalesOrderMirror.findMany({
        where: { wmsSalesOrderId: { in: fetched.map((s) => s.salesOrderId) } },
      })
    ).map((m) => [m.wmsSalesOrderId, m]),
  );
  for (const so of fetched) await upsertMirror(so, fetchedAt, storedById.get(so.salesOrderId));

  const mirrors = (
    await prisma.wmsSalesOrderMirror.findMany({
      where: { OR: [{ orderDate: { gte: windowStart } }, { orderDate: null }] },
    })
  ).map((m) => ({
    salesOrderId: m.wmsSalesOrderId,
    orderNo: m.orderNo,
    refNo: m.refNo,
    partyRefOrderNo: m.partyRefOrderNo,
    lines: (m.lines ?? []) as unknown as SoLine[],
    linesKnown: m.linesKnown,
    orderDate: m.orderDate,
  }));

  // How far back our SO knowledge actually reaches. Both feeds are recent-only, so a
  // PO emailed before this cannot be judged for a missing SO (see evaluateSoCheck).
  const soHistoryStart = mirrors.reduce<Date | null>((oldest, m) => {
    const d = m.orderDate;
    return d && (!oldest || d < oldest) ? d : oldest;
  }, null);
  if (soHistoryStart) {
    console.info(`[so-check] SO history reaches back to ${soHistoryStart.toISOString().slice(0, 10)}`);
  } else {
    console.warn("[so-check] no mirrored SOs yet — missing-SO flags stay off until history exists");
  }

  // One EAN lookup for every line in the window rather than one per PO.
  const eanMap = await mapEansToInternal(
    pos.flatMap((po) => po.lineItems.map((l) => eanFromRaw(l.rawData))),
  ).catch(() => new Map<string, string>());

  const byResult: Partial<Record<SoCheckResult, number>> = {};
  const matchedIds = new Set<string>();
  let flagged = 0;
  let posChecked = 0;
  let cleared = 0;

  for (const po of pos) {
    const matched = mirrors.filter((so) => soMatchesPo(so, po));
    for (const so of matched) matchedIds.add(so.salesOrderId);
    const approved: SoLine[] = po.lineItems
      .filter((l) => (l.approvedQty ?? 0) > 0)
      .map((l) => ({
        skuCode: resolveLineInternalSku({
          source: po.source,
          channelCode: l.sku.internalCode,
          pvId: pvIdFromRaw(l.rawData),
          ean: eanFromRaw(l.rawData),
          eanMap,
        }),
        qty: l.approvedQty!,
      }));

    // Link the matched mirror rows to this PO so the drawer can show them.
    if (matched.length > 0) {
      await prisma.wmsSalesOrderMirror.updateMany({
        where: { wmsSalesOrderId: { in: matched.map((s) => s.salesOrderId) } },
        data: { poId: po.id },
      });
    }

    const evaluation = evaluateSoCheck({
      // The punch is expected once the warehouse has the email, so that is the clock.
      po: { ...po, approvedAt: po.emailSentAt ?? po.approvedAt },
      shipped: SHIPPED_STATUSES.has(po.status),
      soHistoryStart,
      approved,
      sos: matched,
      now: fetchedAt,
      missingSlaHours: env.SO_MISSING_SLA_HOURS,
      soFeedFresh: true, // we got here, so the read-back succeeded
    });
    if (!evaluation) {
      // Nothing to conclude any more (still inside the SLA, already shipped, or outside
      // our SO history). Clear any verdict left from an earlier run, or a stale flag
      // would sit on the page forever — the first production run wrote 348 MISSING_SO
      // rows this way before the coverage guard existed.
      if (await prisma.soCheck.findUnique({ where: { poId: po.id }, select: { poId: true } })) {
        await prisma.soCheck.delete({ where: { poId: po.id } });
        cleared++;
      }
      continue; // PO shows as "awaiting punch"
    }

    posChecked++;
    byResult[evaluation.result] = (byResult[evaluation.result] ?? 0) + 1;
    // QTY_UNVERIFIED is a limitation of the read path, not a warehouse mistake — it
    // must not count as a flag or every PO would look like a problem.
    if (evaluation.result !== "MATCHED" && evaluation.result !== "QTY_UNVERIFIED") flagged++;

    const existing = await prisma.soCheck.findUnique({ where: { poId: po.id } });
    // A manual resolution survives while the verdict is unchanged; a different
    // verdict is a different problem, so it reopens.
    const keepResolution = existing?.result === evaluation.result;
    await prisma.soCheck.upsert({
      where: { poId: po.id },
      create: {
        poId: po.id,
        result: evaluation.result,
        ourQty: evaluation.ourQty,
        wmsQty: evaluation.wmsQty,
        soCount: evaluation.soCount,
        diff: evaluation.diff,
        checkedAt: fetchedAt,
      },
      update: {
        result: evaluation.result,
        ourQty: evaluation.ourQty,
        wmsQty: evaluation.wmsQty,
        soCount: evaluation.soCount,
        diff: evaluation.diff,
        checkedAt: fetchedAt,
        ...(keepResolution ? {} : { resolvedAt: null, resolvedBy: null, note: null }),
      },
    });
  }

  // A PO that has since closed keeps no verdict — it has left this page for good.
  const closedCleanup = await prisma.soCheck.deleteMany({
    where: { po: { status: CLOSED_STATUS } },
  });
  if (closedCleanup.count > 0) {
    cleared += closedCleanup.count;
    console.info(`[so-check] dropped ${closedCleanup.count} verdicts on now-closed POs`);
  }

  const unmatched = mirrors.filter((m) => !matchedIds.has(m.salesOrderId)).length;
  if (unmatched > 0) {
    // SOs nobody could match are their own signal — a reference we don't recognise
    // (or an SO for a PO outside the window). Kept mirrored, counted here.
    console.info(`[so-check] ${unmatched} mirrored SOs matched no PO in the window`);
  }

  console.info(
    `[so-check] ${sos.length} SOs read, ${posChecked} POs checked, ${flagged} flagged` +
      (cleared > 0 ? `, ${cleared} stale verdicts cleared` : ""),
    byResult,
  );
  return { ok: true, salesOrders: sos.length, posChecked, flagged, cleared, byResult };
}

/**
 * Upserts one mirrored SO. Never writes `poId` — the PO link is set separately once a
 * match is found, so re-reading an SO can't orphan a link established earlier.
 */
async function upsertMirror(
  so: WmsSalesOrderRow & { lines: SoLine[] },
  fetchedAt: Date,
  stored?: { orderNo: string | null; refNo: string | null; partyRefOrderNo: string | null;
    warehouseCode: string | null; orderDate: Date | null; status: string | null;
    customer: string | null; lines: unknown; linesKnown: boolean },
): Promise<void> {
  const incoming = {
    orderNo: so.orderNo,
    refNo: so.refNo,
    partyRefOrderNo: so.partyRefOrderNo,
    warehouseCode: so.warehouseName ? (warehouseByWmsName(so.warehouseName)?.code ?? null) : null,
    orderDate: so.orderDate,
    status: so.status ?? null,
    customer: so.customer ?? null,
    lines: so.lines,
    linesKnown: so.linesKnown,
  };
  const merged = mergeMirrorFields(
    stored ? { ...stored, lines: (stored.lines ?? []) as unknown as SoLine[] } : null,
    incoming,
  );
  // `lines` is Json in Prisma, which won't accept a typed array directly.
  const data = { ...merged, lines: merged.lines as unknown as Prisma.InputJsonValue, fetchedAt };
  await prisma.wmsSalesOrderMirror.upsert({
    where: { wmsSalesOrderId: so.salesOrderId },
    create: { wmsSalesOrderId: so.salesOrderId, ...data },
    update: data,
  });
}

/** True when SO read-back is possible at all (drives the "not connected" banner). */
export function soReadPathConfigured(): boolean {
  return wmsConfigured();
}

/**
 * True when line quantities are readable at all. They come from the Outward LOI Report,
 * which is dispatch-driven: an SO gets its quantities verified once it ships. Until then
 * the KPI feed only proves the SO exists (QTY_UNVERIFIED), which the UI explains.
 */
export function soQuantitiesReadable(): boolean {
  return wmsConfigured();
}
