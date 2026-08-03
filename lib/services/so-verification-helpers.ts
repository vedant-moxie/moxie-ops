/**
 * Pure compare logic for the SO Entry Check (plan 008 Phase 3).
 *
 * Deliberately free of "server-only", env and prisma imports so it can be unit
 * tested directly (see so-verification.test.ts) — same split as
 * po-documents-helpers.ts. All I/O lives in so-verification.ts.
 */
import type { SoCheckResult } from "@prisma/client";

export interface SoLine {
  skuCode: string;
  qty: number;
}

export interface MatchableSo {
  salesOrderId: string;
  orderNo: string | null;
  refNo: string | null;
  partyRefOrderNo: string | null;
  lines: SoLine[];
  /**
   * False when the source gave us the SO header but no lines (the KPI feed). `lines: []`
   * then means "unknown", not "zero" — treating it as zero would report every punched SO
   * as a total shortfall. Defaults to true so report-sourced SOs behave as before.
   */
  linesKnown?: boolean;
}

export interface SoCheckEvaluation {
  result: SoCheckResult;
  ourQty: number;
  wmsQty: number;
  soCount: number;
  /** SKU-wise rows that differ; [] when everything ties out */
  diff: Array<{ skuCode: string; ourQty: number; wmsQty: number }>;
  /** Which of the two references we could find on the matched SO(s) */
  refs: { channelPo: boolean; mbRef: boolean };
  /** False when the source gave no SO lines, so quantities could not be compared. */
  qtyComparable: boolean;
}

/** The mirrored fields that either source may or may not know about an SO. */
export interface MirrorFields {
  orderNo: string | null;
  refNo: string | null;
  partyRefOrderNo: string | null;
  warehouseCode?: string | null;
  warehouseName?: string | null;
  orderDate: Date | null;
  status?: string | null;
  customer?: string | null;
  lines: SoLine[];
  linesKnown: boolean;
}

/**
 * Merges a freshly-read SO over what we already mirrored, so a weaker source can never
 * erase a stronger one.
 *
 * This matters because the two feeds know different things and run at different rates:
 * the hourly KPI feed has no line quantities and only one reference field, while the
 * daily Outward LOI Report has quantities and both PO numbers. Without this, the next
 * hourly run would wipe the quantities the daily run collected and every verified PO
 * would silently fall back to QTY_UNVERIFIED.
 *
 * Rules: quantities are only replaced by other real quantities; a null field never
 * overwrites a known value.
 */
export function mergeMirrorFields<T extends MirrorFields>(existing: T | null | undefined, incoming: T): T {
  if (!existing) return incoming;
  const keepLines = existing.linesKnown && !incoming.linesKnown;
  return {
    ...incoming,
    lines: keepLines ? existing.lines : incoming.lines,
    linesKnown: incoming.linesKnown || existing.linesKnown,
    orderNo: incoming.orderNo ?? existing.orderNo,
    refNo: incoming.refNo ?? existing.refNo,
    partyRefOrderNo: incoming.partyRefOrderNo ?? existing.partyRefOrderNo,
    warehouseCode: incoming.warehouseCode ?? existing.warehouseCode,
    warehouseName: incoming.warehouseName ?? existing.warehouseName,
    orderDate: incoming.orderDate ?? existing.orderDate,
    status: incoming.status ?? existing.status,
    customer: incoming.customer ?? existing.customer,
  };
}

/** Uppercase + strip punctuation so "MB - 26/27 - 1458" == "MB26271458". */
export function normRef(v: string | null | undefined): string {
  return String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** True when this SO carries either of the PO's references in any of its ref fields. */
export function soMatchesPo(
  so: Pick<MatchableSo, "orderNo" | "refNo" | "partyRefOrderNo">,
  po: { channelPoNumber: string | null; emailRef: string | null; id?: string },
): boolean {
  // po.id is included because the existing auto-push falls back to it for order_no.
  const wanted = [po.channelPoNumber, po.emailRef, po.id].map(normRef).filter(Boolean);
  if (wanted.length === 0) return false;
  const have = [so.orderNo, so.refNo, so.partyRefOrderNo].map(normRef).filter(Boolean);
  return have.some((h) => wanted.includes(h));
}

/**
 * Compares approved quantities against the matched SO(s). Quantity only, SKU-wise
 * (ops rule — no value/MRP check), plus a presence check on both PO references.
 *
 * Severity order — a PO can trip several rules, and the one that costs money wins:
 *   DUPLICATE_SO  double-punched → stock double-blocked
 *   QTY_MISMATCH  wrong units will ship
 *   REF_MISSING   right units, but the SO can't be traced back to the PO
 *
 * Multiple SOs are NOT a problem on their own — splitting a punch is valid, so the
 * quantities are summed. It only becomes DUPLICATE_SO when the sum overshoots what
 * we approved (the signature of the same lines punched twice).
 *
 * Returns null when there is nothing to say yet (no SO but still inside the SLA, or
 * no SO read-back to compare against) so no row is written and the PO simply shows
 * as awaiting its punch.
 *
 * `soFeedFresh` guards the missing-SO watchdog: with no successful read-back we
 * cannot tell "not punched" from "not fetched", so nothing is flagged.
 */
export function evaluateSoCheck(input: {
  /** `approvedAt` here is the moment the warehouse was told to punch (the prep email). */
  po: { channelPoNumber: string | null; emailRef: string | null; approvedAt: Date | null };
  approved: SoLine[];
  sos: MatchableSo[];
  now: Date;
  missingSlaHours?: number;
  soFeedFresh: boolean;
  /** True once the goods have left — suppresses MISSING_SO (see SHIPPED_STATUSES). */
  shipped?: boolean;
  /**
   * Oldest sales order we hold. A PO emailed before this can't be judged: its SO was
   * punched and dispatched before we ever started collecting, so its absence from our
   * mirror says nothing. Null (no SOs at all) means judge nothing.
   */
  soHistoryStart?: Date | null;
}): SoCheckEvaluation | null {
  const { po, approved, sos, now, soFeedFresh, shipped, soHistoryStart } = input;
  const slaHours = input.missingSlaHours ?? 24;

  const ourBySku = new Map<string, number>();
  for (const l of approved) {
    if (l.qty > 0) ourBySku.set(l.skuCode, (ourBySku.get(l.skuCode) ?? 0) + l.qty);
  }
  const wmsBySku = new Map<string, number>();
  for (const so of sos) {
    for (const l of so.lines) {
      if (l.qty !== 0) wmsBySku.set(l.skuCode, (wmsBySku.get(l.skuCode) ?? 0) + l.qty);
    }
  }
  const ourQty = [...ourBySku.values()].reduce((a, b) => a + b, 0);
  const wmsQty = [...wmsBySku.values()].reduce((a, b) => a + b, 0);

  // Quantities are only comparable when EVERY matched SO reported its lines. One
  // header-only SO in a split punch makes the sum meaningless, not partially useful.
  const qtyComparable = sos.length > 0 && sos.every((so) => so.linesKnown !== false);

  const diff: SoCheckEvaluation["diff"] = [];
  if (qtyComparable) {
    for (const skuCode of new Set([...ourBySku.keys(), ...wmsBySku.keys()])) {
      const ours = ourBySku.get(skuCode) ?? 0;
      const theirs = wmsBySku.get(skuCode) ?? 0;
      if (ours !== theirs) diff.push({ skuCode, ourQty: ours, wmsQty: theirs });
    }
    // Worst offender first — the drawer reads top-down.
    diff.sort((a, b) => Math.abs(b.ourQty - b.wmsQty) - Math.abs(a.ourQty - a.wmsQty));
  }

  const carries = (want: string | null) =>
    !!normRef(want) &&
    sos.some((so) => [so.orderNo, so.refNo, so.partyRefOrderNo].some((v) => normRef(v) === normRef(want)));
  const refs = { channelPo: carries(po.channelPoNumber), mbRef: carries(po.emailRef) };

  const base = {
    ourQty,
    wmsQty: qtyComparable ? wmsQty : 0,
    soCount: sos.length,
    diff,
    refs,
    qtyComparable,
  };

  if (sos.length === 0) {
    if (!soFeedFresh) return null;
    // Already dispatched/received: the stock demonstrably moved, so a missing SO is our
    // mirror aging out, not the warehouse forgetting. Saying "awaiting punch" on a
    // closed PO is noise.
    if (shipped) return null;
    const toldAt = po.approvedAt?.getTime();
    if (!toldAt || now.getTime() - toldAt < slaHours * 3_600_000) return null;
    // Outside our SO history there is nothing to conclude from. Both WMS feeds are
    // recent-only (undispatched SOs, plus a rolling dispatched window), so a PO emailed
    // before our earliest mirrored SO had its punch happen where we cannot see. Without
    // this guard a fresh deployment flags every historical PO at once — 348 of 348 on
    // the first production run — which is noise, not a finding.
    if (!soHistoryStart || toldAt < soHistoryStart.getTime()) return null;
    return { ...base, result: "MISSING_SO" };
  }

  // Reference check works on whatever the source exposes. The KPI feed gives one
  // reference field, so "both numbers present" degrades to "at least one of ours is
  // recognisable" — a reference we can't place at all is what actually blocks tracing.
  const anyRef = refs.channelPo || refs.mbRef;

  if (!qtyComparable) {
    // Header-only source: a double-punch is indistinguishable from a valid split punch
    // without quantities, so it is NOT flagged — soCount is surfaced in the UI instead.
    if (!anyRef) return { ...base, result: "REF_MISSING" };
    return { ...base, result: "QTY_UNVERIFIED" };
  }

  const overshoot = [...wmsBySku.entries()].some(([sku, qty]) => qty > (ourBySku.get(sku) ?? 0));
  if (sos.length > 1 && overshoot) return { ...base, result: "DUPLICATE_SO" };
  if (diff.length > 0) return { ...base, result: "QTY_MISMATCH" };
  if (!refs.channelPo || !refs.mbRef) return { ...base, result: "REF_MISSING" };
  return { ...base, result: "MATCHED" };
}
