import { EXPECTED_TAXABLE_VALUE } from "@/lib/sku-master-data";

export interface TaxableLineResult {
  lineId: string;
  sku: string;
  channelSkuCode: string | null;
  expected: number | null;
  actual: number | null;
  confidence: "high" | "low";
  mismatch: boolean;
  reason: string;
}

export interface TaxableValidationResult {
  lines: TaxableLineResult[];
  hasTaxableMismatch: boolean;
}

// Tolerance: flag if |expected - actual| > TOLERANCE_PCT * expected OR > TOLERANCE_ABS.
const TOLERANCE_PCT = 0.005; // 0.5%
const TOLERANCE_ABS = 1.0; // Re 1 flat

function channelKey(channelName: string): string {
  const n = channelName.toUpperCase().replace(/\s+/g, "");
  if (n.includes("BLINKIT")) return "BLINKIT";
  if (n.includes("ZEPTO")) return "ZEPTO";
  if (n.includes("INSTAMART")) return "INSTAMART";
  if (n.includes("NYKAA")) return "NYKAA";
  if (n.includes("MYNTRA")) return "MYNTRA";
  if (n.includes("RELIANCE")) return "RELIANCE";
  if (n.includes("AMAZON")) return "AMAZONNOW";
  return n;
}

function extractActual(
  channelName: string,
  raw: Record<string, unknown>,
  qty: number,
  storedUnitPrice: number | null,
): { value: number | null; confidence: "high" | "low" } {
  const ch = channelKey(channelName);
  const num = (v: unknown): number | null => {
    if (v == null) return null;
    const n = typeof v === "number" ? v : parseFloat(String(v));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  if (ch === "BLINKIT") {
    // Blinkit dump rawData is a flat CSV row — look for explicit taxable field first,
    // then fall through to unitPrice-equivalent (basic_cost, landing_cost, cost_price).
    const v =
      num(raw.taxable_value) ??
      num(raw.basic_cost) ??
      num(raw.landing_cost) ??
      num(raw.landing_rate) ??
      num(raw.cost_price) ??
      num(raw.unit_cost) ??
      num(raw.unitcost) ??
      num(raw.basiccost) ??
      num(raw.landingcost) ??
      storedUnitPrice;
    return { value: v, confidence: "high" };
  }

  if (ch === "ZEPTO") {
    // Zepto live API line — look for taxable_value first, then unit_price / unitPrice / price.
    const direct =
      num(raw.taxable_value) ??
      num(raw.unit_price) ??
      num(raw.unitPrice) ??
      num(raw.price);
    if (direct != null) return { value: direct, confidence: "high" };
    // Fall back to stored unitPrice (may be derived from PO-level total / qty).
    if (storedUnitPrice != null) return { value: storedUnitPrice, confidence: "high" };
    return { value: null, confidence: "low" };
  }

  if (ch === "INSTAMART") {
    // Instamart live API line — look for taxable_value first, then unit_price / price.
    const direct =
      num(raw.taxable_value) ??
      num(raw.unit_price) ??
      num(raw.unitPrice) ??
      num(raw.price);
    if (direct != null) return { value: direct, confidence: "high" };
    if (storedUnitPrice != null) return { value: storedUnitPrice, confidence: "high" };
    return { value: null, confidence: "low" };
  }

  // Generic fallback: use stored unitPrice.
  const v = storedUnitPrice;
  return { value: v, confidence: "high" };
}

type PoWithLines = {
  channel: { name: string };
  lineItems: Array<{
    id: string;
    rawData: unknown;
    unitPrice: number | null;
    requestedQty: number;
    channelSkuCode: string | null;
    sku: { internalCode: string };
  }>;
};

export function validatePoTaxables(po: PoWithLines): TaxableValidationResult {
  const channelExpected = EXPECTED_TAXABLE_VALUE[channelKey(po.channel.name)] ?? {};

  const lines: TaxableLineResult[] = po.lineItems.map((li) => {
    const raw = (typeof li.rawData === "object" && li.rawData !== null && !Array.isArray(li.rawData)
      ? (li.rawData as Record<string, unknown>)
      : {});

    const internalSku = li.sku.internalCode;
    const expected: number | null = channelExpected[internalSku] ?? null;
    const { value: actual, confidence } = extractActual(
      po.channel.name,
      raw,
      li.requestedQty,
      li.unitPrice,
    );

    let mismatch = false;
    let reason = "";

    if (expected == null) {
      reason = "No expected value in SKU master";
    } else if (actual == null) {
      reason = "Could not determine actual taxable value";
    } else {
      const diff = Math.abs(expected - actual);
      const pctDiff = expected > 0 ? diff / expected : diff;
      if (diff > TOLERANCE_ABS && pctDiff > TOLERANCE_PCT) {
        mismatch = true;
        reason = `Expected ₹${expected.toFixed(2)}, got ₹${actual.toFixed(2)} (diff ₹${diff.toFixed(2)}, ${(pctDiff * 100).toFixed(1)}%)`;
      }
    }

    return {
      lineId: li.id,
      sku: internalSku,
      channelSkuCode: li.channelSkuCode,
      expected,
      actual,
      confidence,
      mismatch,
      reason,
    };
  });

  return {
    lines,
    hasTaxableMismatch: lines.some((l) => l.mismatch),
  };
}
