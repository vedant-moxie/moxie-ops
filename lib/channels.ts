/**
 * Single source of truth for the sales channels surfaced in the Channels hub.
 * Shared by the channels index, the per-channel detail page, and the dashboard
 * component. Plain module (no "use client" / "server-only") so it is importable
 * from both server components and client components.
 *
 * `source` maps to PurchaseOrder.source (a free-form string column).
 * `hasUpload` gates the CSV/dump upload control — only Blinkit ingests files today.
 */
export interface ChannelConfig {
  slug: string;
  name: string;
  source: string;
  logoColor: string;
  hasUpload: boolean;
}

export const CHANNELS: ChannelConfig[] = [
  { slug: "blinkit", name: "Blinkit", source: "BLINKIT", logoColor: "#f8cb46", hasUpload: true },
  { slug: "instamart", name: "Instamart", source: "INSTAMART", logoColor: "#fc8019", hasUpload: false },
  { slug: "zepto", name: "Zepto", source: "ZEPTO", logoColor: "#7e3aed", hasUpload: false },
  { slug: "nykaa", name: "Nykaa", source: "NYKAA", logoColor: "#fc2779", hasUpload: false },
  { slug: "tira", name: "Tira", source: "TIRA", logoColor: "#E8552D", hasUpload: false },
  { slug: "myntra", name: "Myntra", source: "MYNTRA", logoColor: "#FF3F6C", hasUpload: false },
  { slug: "reliance", name: "Reliance", source: "RELIANCE", logoColor: "#0C831F", hasUpload: false },
  { slug: "amazon-now", name: "Amazon Now", source: "AMAZON_NOW", logoColor: "#146EB4", hasUpload: false },
];

export function getChannel(slug: string): ChannelConfig | undefined {
  return CHANNELS.find((c) => c.slug === slug);
}
