/**
 * Fill-rate computation shared by the PO-detail page, the GRN table, and analytics.
 *
 * Two rates, per the ops definition:
 *   • Gross fill = delivered ÷ ordered      — how much of the channel's PO ask we ultimately fulfilled.
 *   • Net fill   = delivered ÷ assigned      — of what WE committed to send, how much actually arrived.
 *
 * "assigned" per line = the team's allocation (PoLineItem.approvedQty) when present,
 * else the channel's ASN / assigned quantity carried in the scraped rawData (Zepto
 * exposes `asnQty`; other channels use other names — see ASN_RAW_KEYS). When no
 * assigned quantity is known for any line, net fill is null (shown as "—") rather
 * than faked — it only appears once the team allocates or the channel's ASN is scraped.
 *
 * Plain module (no "server-only") so it is importable from server components and
 * server-side services alike. Callers pass already-fetched Prisma rows.
 */

/** rawData keys that carry a channel's assigned / ASN / confirmed quantity. */
const ASN_RAW_KEYS = [
  "asnQty", "asn_qty", "asnQuantity", "asn_quantity",
  "assignedQty", "assigned_qty",
  "confirmedQty", "confirmed_qty",
  "appointmentQty", "appointment_qty",
  "committedQty", "committed_qty",
  "dispatchQty", "dispatch_qty",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toQty(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Pull an ASN / assigned quantity out of a line's scraped rawData, if any key matches. */
export function asnQtyFromRaw(rawData: unknown): number | null {
  if (!isRecord(rawData)) return null;
  for (const key of ASN_RAW_KEYS) {
    const q = toQty(rawData[key]);
    if (q != null) return q;
  }
  return null;
}

export interface FillLineInput {
  skuId: string;
  requestedQty: number;
  approvedQty: number | null;
  rawData: unknown;
}

export interface FillLineResult {
  skuId: string;
  ordered: number;
  received: number;
  /** Team allocation if present, else scraped ASN; null when neither is known. */
  assigned: number | null;
  /** Per-line gross fill % (delivered ÷ ordered, capped at 100), or null. */
  grossPct: number | null;
  /** Per-line net fill % (delivered ÷ assigned, capped at 100), or null when unassigned. */
  netPct: number | null;
}

export interface FillRateResult {
  totalOrdered: number;
  totalReceived: number;
  /** Sum of assigned qty across lines that have one. */
  totalAssigned: number;
  /** True when at least one line has a known assigned/ASN qty. */
  hasAssigned: boolean;
  /** Whether a GRN exists at all (received data present). */
  hasGrn: boolean;
  /** Gross fill % (delivered ÷ ordered), null when nothing ordered or no GRN. */
  grossPct: number | null;
  /** Net fill % (delivered ÷ assigned), null when no assigned qty is known. */
  netPct: number | null;
  /** Raw numerators/denominators (capped) so callers can aggregate across POs. */
  grossNum: number; // Σ min(received, ordered)
  grossDen: number; // Σ ordered  (= totalOrdered)
  netNum: number; // Σ min(received, assigned) over assigned lines
  netDen: number; // Σ assigned over assigned lines
  perLine: FillLineResult[];
}

const pct = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 1000) / 10 : null;

/**
 * Compute gross + net fill for one PO from its line items and (optional) GRN lines.
 * Per-line received is matched by skuId. Fill rates cap received at the denominator
 * so over-delivery never reads above 100%.
 */
export function computeFillRates(
  lineItems: FillLineInput[],
  grnLineItems: { skuId: string; receivedQty: number }[] | null | undefined,
): FillRateResult {
  const hasGrn = grnLineItems != null;
  const receivedBySku = new Map<string, number>();
  for (const g of grnLineItems ?? []) {
    receivedBySku.set(g.skuId, (receivedBySku.get(g.skuId) ?? 0) + g.receivedQty);
  }

  let totalOrdered = 0;
  let totalReceived = 0;
  let totalAssigned = 0;
  let grossNum = 0; // Σ min(received, ordered)
  let netNum = 0; // Σ min(received, assigned) over assigned lines
  let netDen = 0; // Σ assigned over assigned lines
  let hasAssigned = false;

  const perLine: FillLineResult[] = lineItems.map((li) => {
    const ordered = li.requestedQty;
    const received = receivedBySku.get(li.skuId) ?? 0;
    const assigned = li.approvedQty ?? asnQtyFromRaw(li.rawData);

    totalOrdered += ordered;
    totalReceived += received;
    grossNum += Math.min(received, ordered);

    if (assigned != null) {
      hasAssigned = true;
      totalAssigned += assigned;
      netDen += assigned;
      netNum += Math.min(received, assigned);
    }

    return {
      skuId: li.skuId,
      ordered,
      received,
      assigned,
      grossPct: hasGrn ? pct(Math.min(received, ordered), ordered) : null,
      netPct: assigned != null && hasGrn ? pct(Math.min(received, assigned), assigned) : null,
    };
  });

  return {
    totalOrdered,
    totalReceived,
    totalAssigned,
    hasAssigned,
    hasGrn,
    grossPct: hasGrn ? pct(grossNum, totalOrdered) : null,
    netPct: hasAssigned && hasGrn ? pct(netNum, netDen) : null,
    grossNum,
    grossDen: totalOrdered,
    netNum,
    netDen,
    perLine,
  };
}
