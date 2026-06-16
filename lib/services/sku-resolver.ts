import { skuMasterMaps } from "@/lib/sku-master-runtime";

type ChannelSource = string;

/**
 * Resolves a channel-specific SKU code to the Moxie internal SKU code.
 *
 * source matches case-insensitively against BLINKIT / ZEPTO / INSTAMART / NYKAA /
 * MYNTRA / PURPLLE / TIRA (Reliance). Falls back to channelCode if no mapping
 * exists (never blanks the column). Reads the live SKU master cache (DB-backed on
 * the server, file defaults otherwise).
 */
function mapFor(source: ChannelSource): Record<string, string> | null {
  const s = source.toUpperCase();
  const maps = skuMasterMaps();
  if (s.includes("BLINKIT")) return maps.blinkitToInternal;
  if (s.includes("ZEPTO")) return maps.zeptoToInternal;
  if (s.includes("INSTAMART")) return maps.instamartToInternal;
  if (s.includes("NYKAA")) return maps.nykaaToInternal;
  if (s.includes("MYNTRA")) return maps.myntraToInternal;
  if (s.includes("PURPLLE")) return maps.purplleToInternal;
  if (s.includes("TIRA") || s.includes("RELIANCE")) return maps.tiraToInternal;
  return null;
}

export function resolveInternalSku(source: ChannelSource, channelCode: string): string {
  const map = mapFor(source);
  if (!map) return channelCode;
  return map[channelCode] ?? channelCode;
}

/**
 * Resolve an EAN/barcode to the Moxie internal code, or null if unknown.
 * EAN is the universal join — it works even when a channel's code column is
 * wrong or missing (e.g. Zepto's `zeptoCode` holds the pvId UUID, not the
 * skuCode that appears on PO lines).
 */
export function resolveInternalSkuByEan(ean: string | null | undefined): string | null {
  if (!ean) return null;
  return skuMasterMaps().eanToInternal[String(ean).trim()] ?? null;
}

/**
 * Best internal code for a PO line: try the channel-code map first, then fall
 * back to the line's EAN, then the raw channel code. Use this anywhere a SKU is
 * shown to a human or sent to the warehouse/WMS.
 */
export function resolveLineInternalSku(input: {
  source: ChannelSource;
  channelCode: string | null | undefined;
  ean?: string | null;
  /** Authoritative EAN→internal map (from the DB). Consulted before the in-memory
   *  map, which can be empty in the server-component layer. */
  eanMap?: Map<string, string>;
}): string {
  const { source, channelCode, ean, eanMap } = input;
  if (channelCode) {
    const viaCode = resolveInternalSku(source, channelCode);
    if (viaCode !== channelCode) return viaCode; // channel-code map had it
  }
  if (ean) {
    const fromDb = eanMap?.get(ean.trim());
    if (fromDb) return fromDb;
  }
  return resolveInternalSkuByEan(ean) ?? channelCode ?? "";
}

/** Pull an EAN/barcode out of a PO line's raw data (field name varies by channel). */
export function eanFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  for (const k of ["eanNo", "ean", "eanUPC", "ean_upc", "barcode", "eanUpc", "EAN"]) {
    const v = r[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/**
 * True when `channelCode` is a known SKU for this channel — i.e. present in the
 * channel→internal mapping (so it maps to a real Moxie SKU). `false` means the
 * channel ordered a SKU we haven't mapped yet (a new/unknown SKU) — surfaced as a
 * flag during allocation so it can be mapped or removed before sending.
 *
 * Channels without a mapping table (or a blank code) return `true` so we never
 * false-flag manually-entered / already-internal codes.
 */
export function isSkuMapped(source: ChannelSource, channelCode: string | null | undefined): boolean {
  if (!channelCode) return true;
  const map = mapFor(source);
  if (!map) return true;
  return Object.prototype.hasOwnProperty.call(map, channelCode);
}

/**
 * Resolves a channel SKU code to the Moxie internal code without knowing which
 * channel it came from — scans every reverse map. Used where the source channel
 * isn't carried on the row (e.g. the Live ATP sidebar). Returns the code
 * unchanged when no map contains it (already-internal codes pass through).
 */
export function resolveInternalSkuAnyChannel(channelCode: string): string {
  const maps = skuMasterMaps();
  for (const map of [
    maps.blinkitToInternal, maps.zeptoToInternal, maps.instamartToInternal, maps.nykaaToInternal,
    maps.myntraToInternal, maps.purplleToInternal, maps.tiraToInternal,
  ]) {
    const internal = map[channelCode];
    if (internal) return internal;
  }
  return channelCode;
}
