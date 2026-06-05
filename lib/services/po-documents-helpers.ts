/**
 * Pure (no I/O) helpers for PO document processing.
 * Importable from tests and server code alike (no server-only marker).
 */
import type { PurchaseOrder } from "@prisma/client";

// ── GSTIN → Dispatch-From table ────────────────────────────────────────────
// Each row is { state, gstin, dispatchFrom }.  Add new warehouse GSTINs here;
// the resolver reads this at send time — no schema change required.
export const GSTIN_DISPATCH_TABLE = [
  { state: "Haryana", gstin: "06AAKCB7037R1Z1", dispatchFrom: "RGL NCR" },
  { state: "Karnataka", gstin: "29AAKCB7037R1ZT", dispatchFrom: "RGL BLR" },
  { state: "Maharashtra", gstin: "27AAKCB7037R2ZW", dispatchFrom: "RGL MUM" },
] satisfies ReadonlyArray<{ state: string; gstin: string; dispatchFrom: string }>;

// Indian GSTIN: 2-digit state code, 5-letter PAN name, 4-digit year, entity type, check, Z, check
export const GSTIN_RE = /[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]/g;

// ── rawData field for the partnersbiz PO id ────────────────────────────────
// The bulk-PO report column is `po_number` (a numeric string like "51388510000314"),
// which is also persisted to channelPoNumber on PurchaseOrder.
export function extractPoId(
  po: Pick<PurchaseOrder, "channelPoNumber" | "rawData">,
): string | null {
  const fromColumn = po.channelPoNumber?.trim() || null;
  if (fromColumn && /^\d+$/.test(fromColumn)) return fromColumn;

  if (po.rawData && typeof po.rawData === "object" && !Array.isArray(po.rawData)) {
    const raw = po.rawData as Record<string, unknown>;
    const v = raw["po_number"];
    if ((typeof v === "string" || typeof v === "number") && String(v).trim()) {
      return String(v).trim();
    }
  }
  return null;
}

// ── GSTIN extraction from PDF text ─────────────────────────────────────────

export function findGstinsInText(text: string): string[] {
  return [...new Set(text.match(GSTIN_RE) ?? [])];
}

// ── Dispatch-From resolver ──────────────────────────────────────────────────

export type DispatchFromResult =
  | { dispatchFrom: string; gstin: string; warning?: never }
  | { dispatchFrom: null; gstin: string | null; warning: string };

/**
 * Map a GSTIN to a dispatch-from location.
 * Returns null + warning if unknown.
 *
 * The Karnataka entry uses "RGL BLR" (from the user's screenshot).
 * If "BGL" appears anywhere in a PDF it would indicate a different entity;
 * flag it as a warning rather than silently mapping it.
 */
export function resolveDispatchFrom(gstin: string): DispatchFromResult {
  const row = GSTIN_DISPATCH_TABLE.find((r) => r.gstin === gstin);
  if (row) return { dispatchFrom: row.dispatchFrom, gstin };
  return {
    dispatchFrom: null,
    gstin,
    warning: `GSTIN ${gstin} not in GSTIN_DISPATCH_TABLE — add a new row to po-documents-helpers.ts`,
  };
}

/**
 * From a list of GSTINs (e.g. from a PDF), pick the first one in our known table.
 * Our GSTINs are the supplier/consignor GSTINs — they tell us which warehouse ships.
 */
export function resolveDispatchFromGstins(gstins: string[]): DispatchFromResult {
  const known = new Set<string>(GSTIN_DISPATCH_TABLE.map((r) => r.gstin));
  const match = gstins.find((g) => known.has(g));
  if (match) return resolveDispatchFrom(match);
  if (gstins.length === 0) {
    return { dispatchFrom: null, gstin: null, warning: "No GSTINs found in PDF" };
  }
  return resolveDispatchFrom(gstins[0]!);
}
