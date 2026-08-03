/**
 * Unit tests for the SO-entry compare logic (plan 008 Phase 3).
 * Run with: npx tsx lib/services/so-verification.test.ts
 *
 * No database or network access required — the compare rules are pure functions in
 * so-verification-helpers.ts (no server-only constraint); the service around them
 * only does I/O.
 */
import { strict as assert } from "node:assert";
import { soCheckSortRank } from "../status.js";
import {
  evaluateSoCheck,
  mergeMirrorFields,
  normRef,
  soMatchesPo,
  type MatchableSo,
  type MirrorFields,
} from "./so-verification-helpers.js";

const PO = {
  channelPoNumber: "BLK-PO-99812",
  emailRef: "MB - 26/27 - 1458",
  approvedAt: new Date("2026-08-01T06:00:00Z"),
};
const NOW = new Date("2026-08-03T06:00:00Z"); // 48h after approval
const APPROVED = [
  { skuCode: "GCS200", qty: 120 },
  { skuCode: "DRM300", qty: 60 },
];

/** A well-punched SO carrying both references. */
const goodSo = (over: Partial<MatchableSo> = {}): MatchableSo => ({
  salesOrderId: "SO-77001",
  orderNo: "BLK-PO-99812",
  refNo: "MB - 26/27 - 1458",
  partyRefOrderNo: null,
  lines: [
    { skuCode: "GCS200", qty: 120 },
    { skuCode: "DRM300", qty: 60 },
  ],
  ...over,
});

const check = (sos: MatchableSo[], over: Partial<Parameters<typeof evaluateSoCheck>[0]> = {}) =>
  evaluateSoCheck({ po: PO, approved: APPROVED, sos, now: NOW, missingSlaHours: 24, soFeedFresh: true, ...over });

// ── reference normalisation + matching ─────────────────────────────────────

assert.equal(normRef("MB - 26/27 - 1458"), "MB26271458", "strips spaces and slashes");
assert.equal(normRef(null), "", "null is empty");
assert.equal(normRef(" blk-po-99812 "), "BLKPO99812", "uppercases and trims");

assert.ok(soMatchesPo(goodSo(), PO), "matches on either reference");
assert.ok(
  soMatchesPo({ orderNo: null, refNo: null, partyRefOrderNo: "mb 26 27 1458" }, PO),
  "matches the MB ref in party_ref_order_no, punctuation-insensitively",
);
assert.ok(!soMatchesPo({ orderNo: "BLK-PO-11111", refNo: null, partyRefOrderNo: null }, PO), "other PO doesn't match");
assert.ok(
  !soMatchesPo(goodSo(), { channelPoNumber: null, emailRef: null }),
  "a PO with no references never claims an SO",
);

// ── exact match ───────────────────────────────────────────────────────────

const matched = check([goodSo()])!;
assert.equal(matched.result, "MATCHED");
assert.equal(matched.ourQty, 180);
assert.equal(matched.wmsQty, 180);
assert.deepEqual(matched.diff, [], "no diff rows when everything ties out");
assert.deepEqual(matched.refs, { channelPo: true, mbRef: true });

// ── quantity mismatch ─────────────────────────────────────────────────────

const short = check([goodSo({ lines: [{ skuCode: "GCS200", qty: 100 }, { skuCode: "DRM300", qty: 60 }] })])!;
assert.equal(short.result, "QTY_MISMATCH", "under-punch is a mismatch");
assert.deepEqual(short.diff, [{ skuCode: "GCS200", ourQty: 120, wmsQty: 100 }]);
assert.equal(short.wmsQty, 160);

const over = check([goodSo({ lines: [{ skuCode: "GCS200", qty: 200 }, { skuCode: "DRM300", qty: 60 }] })])!;
assert.equal(over.result, "QTY_MISMATCH", "single over-punched SO is a mismatch, not a duplicate");

const missingLine = check([goodSo({ lines: [{ skuCode: "GCS200", qty: 120 }] })])!;
assert.equal(missingLine.result, "QTY_MISMATCH", "a SKU absent from the SO is a mismatch");
assert.deepEqual(missingLine.diff, [{ skuCode: "DRM300", ourQty: 60, wmsQty: 0 }]);

const extraSku = check([
  goodSo({ lines: [...goodSo().lines, { skuCode: "HRHM100", qty: 24 }] }),
])!;
assert.equal(extraSku.result, "QTY_MISMATCH", "a SKU we never ordered is a mismatch");
assert.deepEqual(extraSku.diff, [{ skuCode: "HRHM100", ourQty: 0, wmsQty: 24 }]);

// ── split punch across two SOs is valid ───────────────────────────────────

const split = check([
  goodSo({ salesOrderId: "SO-1", lines: [{ skuCode: "GCS200", qty: 70 }] }),
  goodSo({ salesOrderId: "SO-2", lines: [{ skuCode: "GCS200", qty: 50 }, { skuCode: "DRM300", qty: 60 }] }),
])!;
assert.equal(split.result, "MATCHED", "quantities sum across a split punch");
assert.equal(split.soCount, 2);
assert.equal(split.wmsQty, 180);

// ── duplicate punch ───────────────────────────────────────────────────────

const dupe = check([goodSo({ salesOrderId: "SO-1" }), goodSo({ salesOrderId: "SO-2" })])!;
assert.equal(dupe.result, "DUPLICATE_SO", "the same lines punched twice overshoots");
assert.equal(dupe.wmsQty, 360);

const splitPlusDupeLine = check([
  goodSo({ salesOrderId: "SO-1", lines: [{ skuCode: "GCS200", qty: 120 }] }),
  goodSo({ salesOrderId: "SO-2", lines: [{ skuCode: "GCS200", qty: 10 }, { skuCode: "DRM300", qty: 60 }] }),
])!;
assert.equal(splitPlusDupeLine.result, "DUPLICATE_SO", "overshoot on one SKU across two SOs is a duplicate");

// ── references missing ────────────────────────────────────────────────────

const noMbRef = check([goodSo({ refNo: null })])!;
assert.equal(noMbRef.result, "REF_MISSING", "quantities fine but the MB ref is absent");
assert.deepEqual(noMbRef.refs, { channelPo: true, mbRef: false });

const wrongRef = check([goodSo({ refNo: "MB - 26/27 - 9999" })])!;
assert.equal(wrongRef.result, "REF_MISSING", "a different MB ref does not count as present");

// Money beats hygiene: a PO that is both short-punched and missing a ref reads as QTY_MISMATCH.
const both = check([goodSo({ refNo: null, lines: [{ skuCode: "GCS200", qty: 100 }] })])!;
assert.equal(both.result, "QTY_MISMATCH", "quantity outranks the reference check");

// ── missing SO watchdog ───────────────────────────────────────────────────

assert.equal(check([])!.result, "MISSING_SO", "approved 48h ago with no SO");
assert.equal(
  check([], { now: new Date("2026-08-01T20:00:00Z") }),
  null,
  "still inside the 24h SLA — no flag yet",
);
assert.equal(
  check([], { soFeedFresh: false }),
  null,
  "never flag MISSING_SO when the SO feed failed — that's our blind spot, not their mistake",
);
assert.equal(
  check([], { po: { ...PO, approvedAt: null } }),
  null,
  "no approval timestamp means the SLA clock never started",
);

// ── header-only source (the KPI feed): lines unknown, NOT zero ────────────
// This is the live source today. If `lines: []` were read as "zero units punched",
// every correctly-punched PO would flag as a 100% shortfall.

const headerOnly = (over: Partial<MatchableSo> = {}): MatchableSo =>
  goodSo({ lines: [], linesKnown: false, ...over });

const unverified = check([headerOnly()])!;
assert.equal(unverified.result, "QTY_UNVERIFIED", "SO found and traceable, quantities not readable");
assert.equal(unverified.qtyComparable, false);
assert.deepEqual(unverified.diff, [], "no diff invented from missing lines");
assert.equal(unverified.wmsQty, 0, "wmsQty is not a claim when lines are unknown");
assert.equal(unverified.ourQty, 180, "our own approved total is still reported");

// A reference we can't place still blocks tracing — that IS a real flag.
assert.equal(
  check([headerOnly({ orderNo: "SOMETHING-ELSE", refNo: null })])!.result,
  "REF_MISSING",
  "unrecognisable reference on a header-only SO is still flagged",
);
assert.equal(
  check([headerOnly({ orderNo: null, refNo: "MB - 26/27 - 1458" })])!.result,
  "QTY_UNVERIFIED",
  "one recognisable reference is enough when only one field is exposed",
);

// Missing SO is fully trustworthy on a header-only feed.
assert.equal(check([])!.result, "MISSING_SO", "presence check unaffected by missing lines");

// Two SOs with no quantities: a double-punch and a valid split punch are
// indistinguishable, so this must NOT be flagged as DUPLICATE_SO.
const twoHeaderOnly = check([headerOnly({ salesOrderId: "SO-1" }), headerOnly({ salesOrderId: "SO-2" })])!;
assert.equal(twoHeaderOnly.result, "QTY_UNVERIFIED", "no false duplicate without quantities");
assert.equal(twoHeaderOnly.soCount, 2, "but the SO count is surfaced for a human");

// Mixed sources: one header-only SO makes the whole sum meaningless, not partly usable.
const mixed = check([
  goodSo({ salesOrderId: "SO-1", lines: [{ skuCode: "GCS200", qty: 120 }] }),
  headerOnly({ salesOrderId: "SO-2" }),
])!;
assert.equal(mixed.result, "QTY_UNVERIFIED", "a partial line picture is not compared");
assert.equal(mixed.qtyComparable, false);

// Once lines become readable, the same PO evaluates properly again.
assert.equal(check([goodSo()])!.result, "MATCHED", "upgrades to MATCHED when lines arrive");
assert.equal(check([goodSo()])!.qtyComparable, true);

// ── an already-shipped PO must not be nagged about a missing SO ───────────
// Ops complaint: a PO showing status "Closed" was listed as "Awaiting punch". If the
// goods dispatched and were received, a missing SO is our mirror aging out, not the
// warehouse forgetting — so it must stay silent.

assert.equal(
  check([], { shipped: true }),
  null,
  "no MISSING_SO once the goods have shipped",
);
assert.equal(check([], { shipped: false })!.result, "MISSING_SO", "…but still flagged before dispatch");
// Quantity and reference checks DO still run on a shipped PO when an SO is found.
assert.equal(
  check([goodSo({ lines: [{ skuCode: "GCS200", qty: 100 }] })], { shipped: true })!.result,
  "QTY_MISMATCH",
  "a shipped PO with a real quantity difference is still reported",
);

// ── a weaker source must never erase a stronger one ───────────────────────
// The hourly KPI feed has no quantities and one reference field; the daily Outward LOI
// report has both. Without this merge the hourly run would wipe the daily run's
// quantities and every verified PO would silently fall back to QTY_UNVERIFIED.

const stored: MirrorFields = {
  orderNo: "AHD9923",
  refNo: "MB0920",
  partyRefOrderNo: null,
  warehouseCode: "NCR",
  orderDate: new Date("2026-08-01T00:00:00Z"),
  status: "Invoiced",
  customer: "Nykaa-Ahmedabad Warehouse",
  lines: [{ skuCode: "SW15", qty: 103 }],
  linesKnown: true,
};
const headerOnlyIncoming: MirrorFields = {
  orderNo: null,
  refNo: "P5086863",
  partyRefOrderNo: null,
  warehouseCode: "NCR",
  orderDate: null,
  status: "1d to go",
  customer: null,
  lines: [],
  linesKnown: false,
};

const kept = mergeMirrorFields(stored, headerOnlyIncoming);
assert.equal(kept.linesKnown, true, "quantities survive a header-only refresh");
assert.deepEqual(kept.lines, [{ skuCode: "SW15", qty: 103 }], "…with the actual line intact");
assert.equal(kept.orderNo, "AHD9923", "a null reference does not erase a known one");
assert.equal(kept.refNo, "P5086863", "but a present reference does update");
assert.equal(kept.customer, "Nykaa-Ahmedabad Warehouse", "party survives");
assert.equal(kept.orderDate?.getTime(), stored.orderDate?.getTime(), "date survives");
assert.equal(kept.status, "1d to go", "live status is allowed to change");

// The reverse direction DOES upgrade: real quantities replace the empty placeholder.
const upgraded = mergeMirrorFields(
  { ...stored, lines: [], linesKnown: false },
  { ...stored, lines: [{ skuCode: "SW15", qty: 103 }], linesKnown: true },
);
assert.equal(upgraded.linesKnown, true, "header-only row upgrades once quantities arrive");
assert.deepEqual(upgraded.lines, [{ skuCode: "SW15", qty: 103 }]);

// Corrected quantities must replace the old ones, not be ignored as "already known".
const corrected = mergeMirrorFields(stored, { ...stored, lines: [{ skuCode: "SW15", qty: 90 }] });
assert.deepEqual(corrected.lines, [{ skuCode: "SW15", qty: 90 }], "real quantities always win");

assert.deepEqual(mergeMirrorFields(null, headerOnlyIncoming), headerOnlyIncoming, "first sighting");

// ── auto-clear ────────────────────────────────────────────────────────────
// The same PO, once the WH team fixes the SO in WMS, evaluates clean again — no
// state carried between runs, so flags clear on their own.
assert.equal(check([goodSo({ lines: [{ skuCode: "GCS200", qty: 1 }] })])!.result, "QTY_MISMATCH");
assert.equal(check([goodSo()])!.result, "MATCHED", "re-running after the fix flips back to MATCHED");

// ── list ordering: what costs money first ─────────────────────────────────
// The page is worked top-down, so a clean row must never sit above an open problem,
// and a row someone already resolved must never sit above an untouched one.

const order = (
  [
    ["MATCHED", false],
    ["REF_MISSING", false],
    [null, false],
    ["QTY_MISMATCH", false],
    ["MISSING_SO", false],
    ["QTY_UNVERIFIED", false],
    ["DUPLICATE_SO", false],
    ["MISSING_SO", true], // resolved
  ] as Array<[Parameters<typeof soCheckSortRank>[0], boolean]>
)
  .sort((a, b) => soCheckSortRank(a[0], a[1]) - soCheckSortRank(b[0], b[1]))
  .map(([r, resolved]) => `${r ?? "AWAITING"}${resolved ? "(resolved)" : ""}`);

assert.deepEqual(
  order,
  [
    "MISSING_SO",
    "QTY_MISMATCH",
    "DUPLICATE_SO",
    "REF_MISSING",
    "AWAITING",
    "QTY_UNVERIFIED",
    "MATCHED",
    "MISSING_SO(resolved)",
  ],
  "problems first (worst money impact at the very top), settled rows last, resolved below all",
);
assert.ok(
  soCheckSortRank("MISSING_SO", true) > soCheckSortRank("MATCHED", false),
  "a resolved flag sinks below even a clean match",
);

console.log("✓ so-verification: all assertions passed");
