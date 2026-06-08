#!/usr/bin/env node
/**
 * Regenerates lib/sku-master-data.ts from data/sku-master.csv.
 *
 * Usage:
 *   node scripts/generate-sku-master.mjs
 *
 * To update the master:
 *   1. Replace data/sku-master.csv with the new export (including taxable value columns).
 *   2. Run this script.
 *   3. Commit both files.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CSV = path.join(ROOT, "data", "sku-master.csv");
const OUT = path.join(ROOT, "lib", "sku-master-data.ts");

const lines = fs.readFileSync(CSV, "utf8").trim().split("\n");
const [header, ...rows] = lines;
const cols = header.split(",");

const skuIdx = cols.indexOf("SKU");
const zeptoIdx = cols.indexOf("Zepto SKU code");
const nykaaIdx = cols.indexOf("Nykaa SKU code");
const instamartIdx = cols.indexOf("Instamart SKU code");
const blinkitIdx = cols.indexOf("Blinkit Sku code");
const taxZeptoIdx = cols.indexOf("Taxable Value For Zepto");
const taxNykaaIdx = cols.indexOf("Taxable Value For Nykaa");
const taxInstamartIdx = cols.indexOf("Taxable Value For Instamart");
const taxBlinkitIdx = cols.indexOf("Taxable Value For Blinkit");
const taxMyntraIdx = cols.indexOf("Taxable Value For Myntra");
const taxRelianceIdx = cols.indexOf("Taxable Value For Reliance");
const taxAmazonNowIdx = cols.indexOf("Taxable Value For Amazon Now");

const INVALID = new Set(["", "0", "#N/A"]);
const clean = (v) => {
  const s = (v ?? "").trim().replace(/^"|"$/g, "");
  return INVALID.has(s) ? null : s;
};
const cleanNum = (v) => {
  const s = clean(v);
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const zeptoMap = {};
const nykaaMap = {};
const instamartMap = {};
const blinkitMap = {};

// EXPECTED_TAXABLE_VALUE: channel -> { internalSKU -> expectedUnitTaxable }
const taxByChannel = {
  ZEPTO: {},
  NYKAA: {},
  INSTAMART: {},
  BLINKIT: {},
  MYNTRA: {},
  RELIANCE: {},
  AMAZONNOW: {},
};

for (const line of rows) {
  const fields = line.split(",");
  const sku = clean(fields[skuIdx]);
  if (!sku) continue;
  const z = clean(fields[zeptoIdx]);
  const n = clean(fields[nykaaIdx]);
  const im = clean(fields[instamartIdx]);
  const bk = clean(fields[blinkitIdx]);
  if (z) zeptoMap[z] = sku;
  if (n) nykaaMap[n] = sku;
  if (im) instamartMap[im] = sku;
  if (bk) blinkitMap[bk] = sku;

  const tZepto = cleanNum(fields[taxZeptoIdx]);
  const tNykaa = cleanNum(fields[taxNykaaIdx]);
  const tInstamart = cleanNum(fields[taxInstamartIdx]);
  const tBlinkit = cleanNum(fields[taxBlinkitIdx]);
  const tMyntra = cleanNum(fields[taxMyntraIdx]);
  const tReliance = cleanNum(fields[taxRelianceIdx]);
  const tAmazonNow = cleanNum(fields[taxAmazonNowIdx]);

  if (tZepto != null) taxByChannel.ZEPTO[sku] = tZepto;
  if (tNykaa != null) taxByChannel.NYKAA[sku] = tNykaa;
  if (tInstamart != null) taxByChannel.INSTAMART[sku] = tInstamart;
  if (tBlinkit != null) taxByChannel.BLINKIT[sku] = tBlinkit;
  if (tMyntra != null) taxByChannel.MYNTRA[sku] = tMyntra;
  if (tReliance != null) taxByChannel.RELIANCE[sku] = tReliance;
  if (tAmazonNow != null) taxByChannel.AMAZONNOW[sku] = tAmazonNow;
}

const toTs = (map) => {
  const entries = Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join("\n");
  return `{\n${entries}\n}`;
};

const taxMapTs = Object.entries(taxByChannel)
  .map(([ch, map]) => {
    const entries = Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `    ${JSON.stringify(k)}: ${v},`)
      .join("\n");
    return `  ${JSON.stringify(ch)}: {\n${entries}\n  },`;
  })
  .join("\n");

const ts = `// AUTO-GENERATED — do not edit directly.
// Source: data/sku-master.csv
// Regenerate: node scripts/generate-sku-master.mjs
// Maps channel SKU codes -> Moxie internal SKU codes (reverse lookup).

export const BLINKIT_TO_INTERNAL: Record<string, string> = ${toTs(blinkitMap)};

export const ZEPTO_TO_INTERNAL: Record<string, string> = ${toTs(zeptoMap)};

export const INSTAMART_TO_INTERNAL: Record<string, string> = ${toTs(instamartMap)};

export const NYKAA_TO_INTERNAL: Record<string, string> = ${toTs(nykaaMap)};

/**
 * Expected per-unit taxable value per channel per internal SKU.
 * Keys: channel name (uppercase: BLINKIT, ZEPTO, INSTAMART, NYKAA, MYNTRA, RELIANCE, AMAZONNOW).
 * Values: internalSKU -> expected unit taxable value in INR (excl. GST).
 * 0 or blank in source sheet = omitted here (no expectation).
 */
export const EXPECTED_TAXABLE_VALUE: Record<string, Record<string, number>> = {
${taxMapTs}
};
`;

fs.writeFileSync(OUT, ts, "utf8");
console.log(`Written ${OUT}`);
