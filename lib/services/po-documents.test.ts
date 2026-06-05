/**
 * Unit tests for the GSTIN extraction + dispatch-from resolver helpers.
 * Run with: npx tsx lib/services/po-documents.test.ts
 *
 * No database or network access required — all helpers under test are pure functions
 * imported from po-documents-helpers.ts (no server-only constraint).
 */
import { strict as assert } from "node:assert";
import {
  GSTIN_DISPATCH_TABLE,
  GSTIN_RE,
  extractPoId,
  findGstinsInText,
  resolveDispatchFrom,
  resolveDispatchFromGstins,
} from "./po-documents-helpers.js";

// ── GSTIN regex ────────────────────────────────────────────────────────────

assert.deepEqual(
  findGstinsInText("Supplier GSTIN: 06AAKCB7037R1Z1 Buyer: 06AAKCM1234P1ZV"),
  ["06AAKCB7037R1Z1", "06AAKCM1234P1ZV"],
  "regex matches multiple GSTINs",
);
assert.deepEqual(findGstinsInText("no gstin here"), [], "returns empty for no matches");
assert.deepEqual(
  findGstinsInText("Duplicate 29AAKCB7037R1ZT 29AAKCB7037R1ZT"),
  ["29AAKCB7037R1ZT"],
  "deduplicates repeated GSTINs",
);

// ── GSTIN_DISPATCH_TABLE entries ────────────────────────────────────────────

assert.equal(GSTIN_DISPATCH_TABLE.length, 3, "table has 3 entries");
const byGstin = Object.fromEntries(GSTIN_DISPATCH_TABLE.map((r) => [r.gstin, r]));

assert.equal(byGstin["06AAKCB7037R1Z1"]?.dispatchFrom, "RGL NCR", "Haryana → RGL NCR");
assert.equal(byGstin["29AAKCB7037R1ZT"]?.dispatchFrom, "RGL BLR", "Karnataka → RGL BLR");
assert.equal(byGstin["27AAKCB7037R2ZW"]?.dispatchFrom, "RGL MUM", "Maharashtra → RGL MUM");

// ── resolveDispatchFrom ────────────────────────────────────────────────────

const ncr = resolveDispatchFrom("06AAKCB7037R1Z1");
assert.equal(ncr.dispatchFrom, "RGL NCR");
assert.equal(ncr.gstin, "06AAKCB7037R1Z1");

const blr = resolveDispatchFrom("29AAKCB7037R1ZT");
assert.equal(blr.dispatchFrom, "RGL BLR");
// Confirm Karnataka uses "RGL BLR" not "BGL" (per user screenshot)
assert.ok(!blr.dispatchFrom?.includes("BGL"), "dispatch-from should be BLR, not BGL");

const mum = resolveDispatchFrom("27AAKCB7037R2ZW");
assert.equal(mum.dispatchFrom, "RGL MUM");

const unknown = resolveDispatchFrom("07AABCA1234A1Z5");
assert.equal(unknown.dispatchFrom, null, "unknown GSTIN → null dispatchFrom");
assert.ok(typeof unknown.warning === "string" && unknown.warning.length > 0, "unknown GSTIN → warning");

// ── resolveDispatchFromGstins ──────────────────────────────────────────────

const mixed = resolveDispatchFromGstins(["07AABCA1234A1Z5", "29AAKCB7037R1ZT", "07AABCX9999B1Z3"]);
assert.equal(mixed.dispatchFrom, "RGL BLR", "picks known GSTIN from mixed list");

const foreign = resolveDispatchFromGstins(["07AABCA1234A1Z5"]);
assert.equal(foreign.dispatchFrom, null, "no known GSTIN → null");

const empty = resolveDispatchFromGstins([]);
assert.equal(empty.dispatchFrom, null, "empty list → null");
assert.ok(typeof empty.warning === "string", "empty list → warning present");

// ── extractPoId ────────────────────────────────────────────────────────────

assert.equal(
  extractPoId({ channelPoNumber: "51388510000314", rawData: null }),
  "51388510000314",
  "numeric channelPoNumber used directly",
);
assert.equal(
  extractPoId({ channelPoNumber: "BL28755", rawData: null }),
  null,
  "non-numeric channelPoNumber → null",
);
assert.equal(
  extractPoId({ channelPoNumber: null, rawData: { po_number: "49989910016045" } }),
  "49989910016045",
  "rawData.po_number used as fallback",
);
assert.equal(
  extractPoId({ channelPoNumber: null, rawData: null }),
  null,
  "null channelPoNumber + null rawData → null",
);

console.log("✓ All po-documents unit tests passed");
