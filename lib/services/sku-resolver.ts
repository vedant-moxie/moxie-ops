import {
  BLINKIT_TO_INTERNAL,
  ZEPTO_TO_INTERNAL,
  INSTAMART_TO_INTERNAL,
  NYKAA_TO_INTERNAL,
} from "@/lib/sku-master-data";

type ChannelSource = string;

/**
 * Resolves a channel-specific SKU code to the Moxie internal SKU code.
 *
 * source matches case-insensitively against BLINKIT / ZEPTO / INSTAMART / NYKAA.
 * Falls back to channelCode if no mapping exists (never blanks the column).
 */
function mapFor(source: ChannelSource): Record<string, string> | null {
  const s = source.toUpperCase();
  if (s.includes("BLINKIT")) return BLINKIT_TO_INTERNAL;
  if (s.includes("ZEPTO")) return ZEPTO_TO_INTERNAL;
  if (s.includes("INSTAMART")) return INSTAMART_TO_INTERNAL;
  if (s.includes("NYKAA")) return NYKAA_TO_INTERNAL;
  return null;
}

export function resolveInternalSku(source: ChannelSource, channelCode: string): string {
  const map = mapFor(source);
  if (!map) return channelCode;
  return map[channelCode] ?? channelCode;
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

const ALL_CHANNEL_MAPS: Record<string, string>[] = [
  BLINKIT_TO_INTERNAL,
  ZEPTO_TO_INTERNAL,
  INSTAMART_TO_INTERNAL,
  NYKAA_TO_INTERNAL,
];

/**
 * Resolves a channel SKU code to the Moxie internal code without knowing which
 * channel it came from — scans every reverse map. Used where the source channel
 * isn't carried on the row (e.g. the Live ATP sidebar). Returns the code
 * unchanged when no map contains it (already-internal codes pass through).
 */
export function resolveInternalSkuAnyChannel(channelCode: string): string {
  for (const map of ALL_CHANNEL_MAPS) {
    const internal = map[channelCode];
    if (internal) return internal;
  }
  return channelCode;
}
