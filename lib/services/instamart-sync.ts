import "server-only";
import { env } from "@/lib/env";
import { getTokens } from "@/lib/integrations/instamart/auth";
import { InstamartClient, InstamartAuthExpired } from "@/lib/integrations/instamart/client";
import type { ParsedSheet } from "@/lib/integrations/blinkit/parse";
import { ingestInstamartRows, type IngestSummary } from "@/lib/services/instamart-ingest";

const IST_OFFSET_MS = 5.5 * 3_600_000;

/** @deprecated The PO endpoint now has a sensible default — this is kept for API compatibility. */
export class InstamartSyncNotConfigured extends Error {}

/** A date N days ago in IST as YYYY-MM-DD. */
function istDaysAgo(n: number): string {
  return new Date(Date.now() + IST_OFFSET_MS - n * 86_400_000).toISOString().slice(0, 10);
}

export interface SyncResult {
  since: string;
  until: string;
  fileName: string | null;
  summary: IngestSummary;
}

/** Keys a PO object's nested line-item array commonly lives under. */
const LINE_KEYS = ["line_items", "lineItems", "items", "products", "skus", "order_items", "orderItems", "po_items", "poItems"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerce a JSON scalar to a trimmed string; objects/arrays are JSON-encoded. */
function scalar(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).trim();
}

/**
 * Normalise an array of PO objects from the portal JSON into a header-keyed
 * sheet (one row per line item) so the channel-agnostic field resolver can map
 * it exactly like the Blinkit dump. PO-level scalar fields are merged onto every
 * line row; nested line-item fields win on key collisions.
 */
function toSheet(pos: Record<string, unknown>[]): ParsedSheet {
  const headerOrder: string[] = [];
  const seen = new Set<string>();
  const rows: Record<string, string>[] = [];

  const pushHeader = (h: string) => {
    if (!seen.has(h)) {
      seen.add(h);
      headerOrder.push(h);
    }
  };

  for (const po of pos) {
    // PO-level scalar fields (skip the nested line arrays themselves).
    const poScalars: Record<string, string> = {};
    let lineArray: Record<string, unknown>[] | null = null;
    for (const [k, v] of Object.entries(po)) {
      if (!lineArray && LINE_KEYS.includes(k) && Array.isArray(v)) {
        lineArray = (v as unknown[]).filter(isRecord);
        continue;
      }
      poScalars[k] = scalar(v);
    }

    const lines = lineArray && lineArray.length > 0 ? lineArray : [po];
    for (const line of lines) {
      const row: Record<string, string> = { ...poScalars };
      for (const [k, v] of Object.entries(line)) {
        if (LINE_KEYS.includes(k) && Array.isArray(v)) continue;
        row[k] = scalar(v); // line-level fields override PO-level on collision
      }
      for (const k of Object.keys(row)) pushHeader(k);
      rows.push(row);
    }
  }

  return { headers: headerOrder, rows };
}

/**
 * Live-scrape Instamart POs from the Swiggy seller portal for [since, until]
 * (defaults: rolling 30-day window through today IST, floored at the backfill
 * date), then ingest into the pipeline. Re-authenticates once via OTP if the
 * cached token has expired.
 */
export async function syncInstamart(opts: { since?: string; until?: string; actorLabel?: string } = {}): Promise<SyncResult> {
  const since = opts.since ?? maxDate(istDaysAgo(30), env.INSTAMART_START_DATE);
  const until = opts.until ?? istDaysAgo(-1); // tomorrow IST so today's POs are caught (inclusive upper bound)

  const runOnce = async (forceRefresh: boolean) => {
    const tokens = await getTokens(forceRefresh);
    const client = new InstamartClient(tokens);
    const summaries = await client.listPurchaseOrders({ since, until });
    // If the detail endpoint is configured, hydrate line items per PO; otherwise
    // rely on whatever line data the listing already embeds.
    if (env.INSTAMART_PO_DETAIL_PATH) {
      const hydrated: Record<string, unknown>[] = [];
      for (const po of summaries) {
        const poNo = pickPoNo(po);
        if (!poNo) {
          hydrated.push(po);
          continue;
        }
        try {
          const lines = await client.getPurchaseOrderDetail(poNo);
          hydrated.push({ ...po, line_items: lines });
        } catch {
          hydrated.push(po); // keep the summary even if detail fetch fails
        }
      }
      return hydrated;
    }
    return summaries;
  };

  let pos: Record<string, unknown>[];
  try {
    pos = await runOnce(false);
  } catch (err) {
    if (err instanceof InstamartAuthExpired) {
      pos = await runOnce(true); // token stale → re-login via OTP and retry once
    } else {
      throw err;
    }
  }

  const fileName = `instamart-po-${since}_to_${until}.json`;
  const sheet = toSheet(pos);
  const summary = await ingestInstamartRows(sheet, fileName, opts.actorLabel ?? "Instamart sync");

  return { since, until, fileName, summary };
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

/** Best-effort dig a PO identifier out of a summary object. */
function pickPoNo(po: Record<string, unknown>): string | null {
  for (const k of ["po_number", "poNumber", "po_no", "poNo", "purchase_order_number", "po_id", "poId", "id"]) {
    const v = po[k];
    if (typeof v === "string" || typeof v === "number") {
      const s = String(v).trim();
      if (s) return s;
    }
  }
  return null;
}
