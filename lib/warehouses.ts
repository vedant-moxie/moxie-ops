/**
 * Canonical warehouse registry — single source of truth linking:
 *  - our short code (stored on WarehouseStock rows)
 *  - the GSTIN printed on channel PO PDFs (decides which warehouse ships)
 *  - the dispatch-from label used in emails/recipients (GSTIN_DISPATCH_TABLE)
 *  - the warehouse name/code as they appear in the WMS (myrgl.com)
 *
 * Pure data module (no I/O) — safe to import from client and server code.
 */

export interface WarehouseInfo {
  /** Short stable code persisted in WarehouseStock.warehouseCode */
  code: string;
  state: string;
  /** Our GSTIN for this warehouse, as printed on channel PO PDFs */
  gstin: string;
  /** Label used by GSTIN_DISPATCH_TABLE / location recipients */
  dispatchFrom: string;
  /** WAREHOUSE column value in WMS stock reports */
  wmsName: string;
  /** warehouse_code in the WMS account (used for sales-order push) */
  wmsCode: string;
}

export const WAREHOUSES: readonly WarehouseInfo[] = [
  {
    code: "NCR",
    state: "Haryana",
    gstin: "06AAKCB7037R1Z1",
    dispatchFrom: "RGL NCR",
    wmsName: "RGL GURGAON HARYANA",
    wmsCode: "G",
  },
  {
    code: "BLR",
    state: "Karnataka",
    gstin: "29AAKCB7037R1ZT",
    dispatchFrom: "RGL BLR",
    wmsName: "RGL BENGALURU",
    wmsCode: "BLR",
  },
  {
    code: "MUM",
    state: "Maharashtra",
    gstin: "27AAKCB7037R2ZW",
    dispatchFrom: "RGL MUM",
    wmsName: "BHIWANDI - 2",
    wmsCode: "WD",
  },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Match the WAREHOUSE column of a WMS report row to a registry entry. */
export function warehouseByWmsName(wmsName: string): WarehouseInfo | null {
  const target = norm(wmsName);
  return WAREHOUSES.find((w) => norm(w.wmsName) === target) ?? null;
}

/** Match a dispatch-from label (e.g. "RGL NCR" from the GSTIN resolver). */
export function warehouseByDispatchFrom(dispatchFrom: string): WarehouseInfo | null {
  const target = norm(dispatchFrom);
  return (
    WAREHOUSES.find((w) => norm(w.dispatchFrom) === target) ??
    WAREHOUSES.find((w) => norm(w.dispatchFrom).includes(target) || target.includes(norm(w.code))) ??
    null
  );
}

export function warehouseByCode(code: string): WarehouseInfo | null {
  return WAREHOUSES.find((w) => w.code === code) ?? null;
}
