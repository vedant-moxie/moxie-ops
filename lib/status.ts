import type {
  PoStatus,
  GrnStatus,
  DiscrepancyStatus,
  DiscrepancyType,
  DiscrepancyBaseline,
  SoCheckResult,
} from "@prisma/client";
import type { BadgeProps } from "@/components/ui/badge";

type Variant = NonNullable<BadgeProps["variant"]>;

export const PO_STATUS_META: Record<
  PoStatus,
  { label: string; variant: Variant }
> = {
  PENDING_REVIEW: { label: "Pending review", variant: "default" },
  PRIORITISED: { label: "Prioritised", variant: "info" },
  ALLOCATED: { label: "Allocated", variant: "purple" },
  APPROVED: { label: "Approved", variant: "purple" },
  DISPATCHED: { label: "Dispatched", variant: "warning" },
  DELIVERED: { label: "Delivered", variant: "mint" },
  GRN_RECEIVED: { label: "GRN received", variant: "info" },
  CLOSED: { label: "Closed", variant: "success" },
  DISCREPANCY: { label: "Discrepancy", variant: "danger" },
  ON_HOLD: { label: "On hold", variant: "warning" },
};

export const PO_STATUS_ORDER: PoStatus[] = [
  "PENDING_REVIEW",
  "PRIORITISED",
  "ALLOCATED",
  "APPROVED",
  "DISPATCHED",
  "DELIVERED",
  "GRN_RECEIVED",
  "CLOSED",
  "DISCREPANCY",
  "ON_HOLD",
];

export const GRN_STATUS_META: Record<GrnStatus, { label: string; variant: Variant }> = {
  PENDING_RECONCILIATION: { label: "Pending", variant: "warning" },
  ACCEPTED: { label: "Accepted", variant: "success" },
  DISCREPANCY_FLAGGED: { label: "Discrepancy", variant: "danger" },
  RESOLVED: { label: "Resolved", variant: "info" },
};

export const DISCREPANCY_STATUS_META: Record<
  DiscrepancyStatus,
  { label: string; variant: Variant }
> = {
  OPEN: { label: "Open", variant: "danger" },
  ACCEPTED: { label: "Accepted", variant: "warning" },
  DEBIT_NOTE_RAISED: { label: "Debit note", variant: "purple" },
  DISPUTED: { label: "Disputed", variant: "info" },
  RESOLVED: { label: "Resolved", variant: "success" },
};

export const DISCREPANCY_TYPE_META: Record<
  DiscrepancyType,
  { label: string; variant: Variant }
> = {
  SHORT_RECEIPT: { label: "Short receipt", variant: "danger" },
  EXCESS_RECEIPT: { label: "Excess", variant: "warning" },
  CHANNEL_REJECTION: { label: "Rejected", variant: "purple" },
};

/** Which quantity the GRN was diffed against — shown as a hint under the expected qty. */
export const DISCREPANCY_BASELINE_LABEL: Record<DiscrepancyBaseline, string> = {
  DISPATCHED: "vs dispatched",
  ASSIGNED: "vs assigned",
  ORDERED: "vs ordered",
};

/**
 * SO Entry Check verdicts (plan 008). `hint` is the one-line "what's off" shown in
 * the table so ops don't have to open the drawer to know what happened.
 */
export const SO_CHECK_META: Record<
  SoCheckResult,
  { label: string; variant: Variant; hint: string }
> = {
  MATCHED: { label: "Matched", variant: "success", hint: "SO matches the PO, SKU-wise" },
  QTY_UNVERIFIED: {
    label: "SO found",
    variant: "info",
    hint: "SO punched and traceable — WMS doesn't expose line quantities, so the SKU-wise check couldn't run",
  },
  QTY_MISMATCH: { label: "Qty mismatch", variant: "danger", hint: "Punched quantities differ from approved" },
  DUPLICATE_SO: { label: "Duplicate SO", variant: "danger", hint: "Punched more than once — stock double-blocked" },
  MISSING_SO: { label: "Missing SO", variant: "purple", hint: "No sales order punched for this PO" },
  REF_MISSING: { label: "PO ref missing", variant: "warning", hint: "Quantities fine, a PO reference is absent" },
  STALE_REVISION: { label: "Stale revision", variant: "warning", hint: "SO still matches the pre-revision numbers" },
};

/**
 * Verdicts that need a human. Excludes MATCHED and QTY_UNVERIFIED — the latter is a
 * limit of the WMS read path, not a warehouse mistake, so it must never read as a flag.
 */
export const SO_CHECK_PROBLEMS: SoCheckResult[] = [
  "QTY_MISMATCH",
  "DUPLICATE_SO",
  "MISSING_SO",
  "REF_MISSING",
  "STALE_REVISION",
];

/**
 * Worst-first sort order for the SO Entry Check list: what costs money or stops a
 * dispatch sits at the top, clean rows at the bottom. `null` = no verdict yet
 * ("awaiting punch"), which ranks after real problems but ahead of settled rows.
 */
const SO_CHECK_RANK: Record<SoCheckResult | "AWAITING", number> = {
  MISSING_SO: 0, // nothing punched — nothing will ship
  QTY_MISMATCH: 1, // wrong units will ship
  DUPLICATE_SO: 2, // stock double-blocked
  STALE_REVISION: 3,
  REF_MISSING: 4, // right units, untraceable
  AWAITING: 5, // still inside the punch window
  QTY_UNVERIFIED: 6, // SO is there; quantities land after dispatch
  MATCHED: 7,
};

/** Sort key for one row. Resolved rows sink below everything still open. */
export function soCheckSortRank(result: SoCheckResult | null, resolved: boolean): number {
  return SO_CHECK_RANK[result ?? "AWAITING"] + (resolved ? 100 : 0);
}

export const PRIORITY_META: Record<string, { label: string; variant: Variant }> = {
  P1: { label: "P1", variant: "danger" },
  P2: { label: "P2", variant: "warning" },
  P3: { label: "P3", variant: "info" },
};
