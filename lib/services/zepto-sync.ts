import "server-only";
import { env } from "@/lib/env";
import { getTokens } from "@/lib/integrations/zepto/auth";
import { ZeptoClient, ZeptoAuthExpired, type RawZeptoPo } from "@/lib/integrations/zepto/client";
import type { ParsedSheet } from "@/lib/integrations/blinkit/parse";
import { ingestZeptoDump, type IngestSummary } from "@/lib/services/zepto-ingest";

const IST_OFFSET_MS = 5.5 * 3_600_000;

/** Raised when sync is invoked before the PO-grid endpoint has been configured. */
export class ZeptoSyncNotConfigured extends Error {}

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const LINE_ARRAY_KEYS = ["lineItems", "items", "skus", "products", "poItems", "orderItems", "lines"];

/** Find the per-PO line-items array within a raw PO record, if embedded. */
function findLineArray(po: RawZeptoPo): RawZeptoPo[] | null {
  for (const k of LINE_ARRAY_KEYS) {
    const v = po[k];
    if (Array.isArray(v) && v.some(isRecord)) return v.filter(isRecord);
  }
  return null;
}

const coerce = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

/**
 * Flatten raw PO records into a ParsedSheet (header list + string rows) so the
 * ingest can reuse the same channel-agnostic field resolution as Blinkit.
 * Each line item becomes a row carrying both PO-header and line-level fields;
 * POs without an embedded line array contribute a single row.
 */
function flattenPosToSheet(pos: RawZeptoPo[]): ParsedSheet {
  const headerKeys = new Set<string>();
  const rows: Record<string, string>[] = [];

  for (const po of pos) {
    const lines = findLineArray(po);
    const headFields: Record<string, string> = {};
    for (const [k, v] of Object.entries(po)) {
      if (LINE_ARRAY_KEYS.includes(k)) continue; // don't stringify the line array into the header
      headFields[k] = coerce(v);
    }
    if (lines && lines.length) {
      for (const line of lines) {
        const row: Record<string, string> = { ...headFields };
        for (const [k, v] of Object.entries(line)) {
          // Prefix collisions so a line "status" doesn't clobber the PO "status".
          const key = k in headFields && coerce(v) !== headFields[k] ? `item_${k}` : k;
          row[key] = coerce(v);
        }
        Object.keys(row).forEach((k) => headerKeys.add(k));
        rows.push(row);
      }
    } else {
      Object.keys(headFields).forEach((k) => headerKeys.add(k));
      rows.push(headFields);
    }
  }

  return { headers: [...headerKeys], rows };
}

/**
 * Live-scrape Zepto POs for [since, until] (defaults: rolling 30-day window
 * through tomorrow IST so settled POs are visible), then ingest into the
 * pipeline. Re-authenticates once via OTP if the cached jwtToken has expired.
 */
export async function syncZepto(opts: { since?: string; until?: string; actorLabel?: string } = {}): Promise<SyncResult> {
  const since = opts.since ?? istDaysAgo(30);
  const until = opts.until ?? istDaysAgo(-1);

  // Fail fast (before spending an OTP login) if the PO-grid endpoint isn't wired
  // up yet — the auth + pagination are ready; only the captured cURL is missing.
  if (!env.ZEPTO_PO_LIST_PATH) {
    throw new ZeptoSyncNotConfigured(
      "Zepto PO endpoint not configured yet — paste the portal PO-grid cURL to enable sync " +
        "(set ZEPTO_PO_LIST_PATH). Auth + pagination are ready.",
    );
  }

  const runOnce = async (forceRefresh: boolean): Promise<RawZeptoPo[]> => {
    const tokens = await getTokens(forceRefresh);
    const client = new ZeptoClient(tokens);
    const pos = await client.listPurchaseOrders({ since, until });
    // If the grid returns header-only rows and a detail endpoint is configured,
    // enrich each PO with its line items.
    if (env.ZEPTO_PO_DETAIL_PATH) {
      for (const po of pos) {
        if (findLineArray(po)) continue;
        const poId = String(po.poId ?? po.id ?? po.poNumber ?? po.po_number ?? "");
        if (!poId) continue;
        const lines = await client.fetchPoLineItems(poId);
        if (lines.length) (po as Record<string, unknown>).lineItems = lines;
      }
    }
    return pos;
  };

  let pos: RawZeptoPo[];
  try {
    pos = await runOnce(false);
  } catch (err) {
    if (err instanceof ZeptoAuthExpired) {
      pos = await runOnce(true); // token stale → re-login via OTP and retry once
    } else {
      throw err;
    }
  }

  const fileName = `zepto-po-${since}_to_${until}.json`;
  const sheet = flattenPosToSheet(pos);
  const summary = await ingestZeptoDump(sheet, fileName, opts.actorLabel ?? "Zepto sync");

  return { since, until, fileName, summary };
}
