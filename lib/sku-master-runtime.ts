/**
 * Client-safe runtime cache of the SKU master maps.
 *
 * Holds the channel-code↔internal mappings, per-channel expected taxable values,
 * and the canonical master-code set used by SKU resolution and the allocation
 * price-mismatch gate. Initialised from the generated file (lib/sku-master-data.ts)
 * so it works with zero setup and in the browser bundle. On the server, the
 * server-only module lib/services/sku-master.ts overwrites it from the DB
 * (at boot and after every edit) — making the DB the live source of truth.
 *
 * No prisma / server-only imports here on purpose: this module is pulled into
 * client components (e.g. the ATP sidebar) via sku-resolver.
 */
import {
  BLINKIT_TO_INTERNAL,
  ZEPTO_TO_INTERNAL,
  INSTAMART_TO_INTERNAL,
  NYKAA_TO_INTERNAL,
  EXPECTED_TAXABLE_VALUE,
  MASTER_SKUS,
} from "@/lib/sku-master-data";

export interface SkuMasterMaps {
  blinkitToInternal: Record<string, string>;
  zeptoToInternal: Record<string, string>;
  instamartToInternal: Record<string, string>;
  nykaaToInternal: Record<string, string>;
  // Standard-platform reverse maps (from the Beauty Comm "Product Master" sheet).
  // Each maps every known platform id (listing code AND numeric PID) → internalCode.
  myntraToInternal: Record<string, string>;
  purplleToInternal: Record<string, string>;
  tiraToInternal: Record<string, string>;
  /** EAN/barcode → internalCode. The universal join — works for any channel whose
   *  PO line carries an EAN, even when its channel-code column is wrong/missing. */
  eanToInternal: Record<string, string>;
  /** CHANNEL (uppercase) → internalCode → expected unit taxable value */
  expectedTaxable: Record<string, Record<string, number>>;
  masterSkus: Set<string>;
}

/** A SkuMaster-shaped row — accepted by buildMapsFromRows (kept prisma-agnostic). */
export interface MasterRowLike {
  internalCode: string;
  zeptoCode?: string | null;
  nykaaCode?: string | null;
  instamartCode?: string | null;
  blinkitCode?: string | null;
  myntraCode?: string | null;
  purplleCode?: string | null;
  tiraCode?: string | null;
  ean?: string | null;
  nykaaPids?: string | null;
  purpllePids?: string | null;
  taxableZepto?: number | null;
  taxableNykaa?: number | null;
  taxableInstamart?: number | null;
  taxableBlinkit?: number | null;
  taxableMyntra?: number | null;
  taxableReliance?: number | null;
  taxableAmazonNow?: number | null;
}

function mapsFromFile(): SkuMasterMaps {
  return {
    blinkitToInternal: { ...BLINKIT_TO_INTERNAL },
    zeptoToInternal: { ...ZEPTO_TO_INTERNAL },
    instamartToInternal: { ...INSTAMART_TO_INTERNAL },
    nykaaToInternal: { ...NYKAA_TO_INTERNAL },
    // No file defaults for standard platforms — populated from the DB master.
    myntraToInternal: {},
    purplleToInternal: {},
    tiraToInternal: {},
    eanToInternal: {},
    expectedTaxable: EXPECTED_TAXABLE_VALUE,
    masterSkus: MASTER_SKUS,
  };
}

/** Split a multi-id cell ("16853282, 16853283") into trimmed non-empty ids. */
function splitIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return String(raw)
    .split(/[,;/|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Build the runtime maps from SkuMaster rows (pure — used by the server refresh). */
export function buildMapsFromRows(rows: MasterRowLike[]): SkuMasterMaps {
  const blinkitToInternal: Record<string, string> = {};
  const zeptoToInternal: Record<string, string> = {};
  const instamartToInternal: Record<string, string> = {};
  const nykaaToInternal: Record<string, string> = {};
  const myntraToInternal: Record<string, string> = {};
  const purplleToInternal: Record<string, string> = {};
  const tiraToInternal: Record<string, string> = {};
  const eanToInternal: Record<string, string> = {};
  const ZEPTO: Record<string, number> = {};
  const NYKAA: Record<string, number> = {};
  const INSTAMART: Record<string, number> = {};
  const BLINKIT: Record<string, number> = {};
  const MYNTRA: Record<string, number> = {};
  const RELIANCE: Record<string, number> = {};
  const AMAZONNOW: Record<string, number> = {};
  const masterSkus = new Set<string>();

  for (const r of rows) {
    const code = r.internalCode?.trim();
    if (!code) continue;
    masterSkus.add(code);
    if (r.blinkitCode) blinkitToInternal[r.blinkitCode] = code;
    if (r.zeptoCode) zeptoToInternal[r.zeptoCode] = code;
    if (r.instamartCode) instamartToInternal[r.instamartCode] = code;
    if (r.nykaaCode) nykaaToInternal[r.nykaaCode] = code;
    // Standard platforms: map both the listing code and every numeric PID.
    if (r.myntraCode) myntraToInternal[r.myntraCode] = code;
    if (r.purplleCode) purplleToInternal[r.purplleCode] = code;
    if (r.tiraCode) tiraToInternal[r.tiraCode] = code;
    if (r.ean) eanToInternal[String(r.ean).trim()] = code;
    for (const pid of splitIds(r.nykaaPids)) nykaaToInternal[pid] = code;
    for (const pid of splitIds(r.purpllePids)) purplleToInternal[pid] = code;
    if (r.taxableZepto != null) ZEPTO[code] = r.taxableZepto;
    if (r.taxableNykaa != null) NYKAA[code] = r.taxableNykaa;
    if (r.taxableInstamart != null) INSTAMART[code] = r.taxableInstamart;
    if (r.taxableBlinkit != null) BLINKIT[code] = r.taxableBlinkit;
    if (r.taxableMyntra != null) MYNTRA[code] = r.taxableMyntra;
    if (r.taxableReliance != null) RELIANCE[code] = r.taxableReliance;
    if (r.taxableAmazonNow != null) AMAZONNOW[code] = r.taxableAmazonNow;
  }
  const expectedTaxable: Record<string, Record<string, number>> = {
    ZEPTO, NYKAA, INSTAMART, BLINKIT, MYNTRA, RELIANCE, AMAZONNOW,
  };
  return {
    blinkitToInternal, zeptoToInternal, instamartToInternal, nykaaToInternal,
    myntraToInternal, purplleToInternal, tiraToInternal, eanToInternal,
    expectedTaxable, masterSkus,
  };
}

let current: SkuMasterMaps = mapsFromFile();

/** Current live maps (file defaults until the server refreshes from DB). */
export function skuMasterMaps(): SkuMasterMaps {
  return current;
}

/** Replace the live maps (called by the server-only refresh). */
export function setSkuMasterMaps(maps: SkuMasterMaps): void {
  current = maps;
}
