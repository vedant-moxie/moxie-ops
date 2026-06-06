import "server-only";
import { env } from "@/lib/env";
import { getTokens } from "@/lib/integrations/zepto/auth";
import { ZeptoClient, ZeptoAuthExpired, type RawZeptoPo } from "@/lib/integrations/zepto/client";
import { ingestLiveZeptoPOs, type IngestSummary } from "@/lib/services/zepto-ingest";

const IST_OFFSET_MS = 5.5 * 3_600_000;

/** @deprecated The PO endpoint now has a sensible default — this is kept for API compatibility. */
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

const LINE_ARRAY_KEYS = ["lineItems", "items", "skus", "products", "poItems", "orderItems", "lines", "line_items"];

/** Find the per-PO line-items array within a raw PO record, if embedded. */
function findLineArray(po: RawZeptoPo): RawZeptoPo[] | null {
  for (const k of LINE_ARRAY_KEYS) {
    const v = po[k];
    if (Array.isArray(v) && v.some(isRecord)) return v.filter(isRecord);
  }
  return null;
}

/**
 * Live-scrape Zepto POs for [since, until] (defaults: rolling 30-day window
 * through tomorrow IST so settled POs are visible), then ingest into the
 * pipeline. Re-authenticates once via OTP if the cached jwtToken has expired.
 *
 * ingestLiveZeptoPOs maps API fields directly, guarantees a valid skuId for
 * every line, and creates a summary PoLineItem when the API returns headers only.
 */
export async function syncZepto(opts: { since?: string; until?: string; actorLabel?: string } = {}): Promise<SyncResult> {
  const since = opts.since ?? istDaysAgo(30);
  const until = opts.until ?? istDaysAgo(-1);

  const runOnce = async (forceRefresh: boolean): Promise<RawZeptoPo[]> => {
    const tokens = await getTokens(forceRefresh);
    const client = new ZeptoClient(tokens);
    const pos = await client.listPurchaseOrders({ since, until });

    // Hydrate each PO with per-SKU line items from the items endpoint.
    // Falls back to the summary line in ingest if the fetch fails.
    for (const po of pos) {
      if (findLineArray(po)) continue;
      const poId = String(po.id ?? po.poId ?? po.poNumber ?? po.po_number ?? "");
      if (!poId) continue;
      try {
        const items = await client.fetchPoItems(poId);
        if (items.length) (po as Record<string, unknown>).items = items;
      } catch (err) {
        console.warn(`[zepto-sync] items fetch failed for PO ${poId}: ${err instanceof Error ? err.message : err}`);
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
  const summary = await ingestLiveZeptoPOs(pos, opts.actorLabel ?? "Zepto sync");
  summary.fileName = fileName;

  return { since, until, fileName, summary };
}
