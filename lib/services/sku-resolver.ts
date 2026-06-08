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
export function resolveInternalSku(source: ChannelSource, channelCode: string): string {
  const s = source.toUpperCase();
  let map: Record<string, string> | null = null;

  if (s.includes("BLINKIT")) map = BLINKIT_TO_INTERNAL;
  else if (s.includes("ZEPTO")) map = ZEPTO_TO_INTERNAL;
  else if (s.includes("INSTAMART")) map = INSTAMART_TO_INTERNAL;
  else if (s.includes("NYKAA")) map = NYKAA_TO_INTERNAL;

  if (!map) return channelCode;
  return map[channelCode] ?? channelCode;
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
