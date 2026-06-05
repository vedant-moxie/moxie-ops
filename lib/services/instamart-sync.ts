import "server-only";
import { env } from "@/lib/env";
import { getTokens } from "@/lib/integrations/instamart/auth";
import { InstamartClient, InstamartAuthExpired } from "@/lib/integrations/instamart/client";
import { ingestLiveInstamartPOs, type IngestSummary } from "@/lib/services/instamart-ingest";

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

/**
 * Live-scrape Instamart POs from the Swiggy seller portal for [since, until]
 * (defaults: rolling 30-day window through today IST, floored at the backfill
 * date), then ingest into the pipeline. Re-authenticates once via OTP if the
 * cached token has expired.
 *
 * The scraper uses picker.swiggy.com/api/v1/searchPurchaseOrder (abacus-token auth,
 * POST, integer pagination). The per-PO detail endpoint is not accessible via
 * server-to-server requests; when INSTAMART_PO_DETAIL_PATH is configured the client
 * will attempt to hydrate line items, otherwise a summary PoLineItem is created from
 * header totals so the ingest never crashes.
 */
export async function syncInstamart(opts: { since?: string; until?: string; actorLabel?: string } = {}): Promise<SyncResult> {
  const since = opts.since ?? maxDate(istDaysAgo(30), env.INSTAMART_START_DATE);
  const until = opts.until ?? istDaysAgo(-1); // tomorrow IST so today's POs are caught

  const runOnce = async (forceRefresh: boolean): Promise<Record<string, unknown>[]> => {
    const tokens = await getTokens(forceRefresh);
    const client = new InstamartClient(tokens);
    const summaries = await client.listPurchaseOrders({ since, until });

    // If the per-PO detail endpoint is configured, hydrate line items per PO.
    // picker.swiggy.com does not expose a working detail endpoint via abacus-token;
    // this path is kept for when the user sets INSTAMART_PO_DETAIL_PATH via Playwright capture.
    if (env.INSTAMART_PO_DETAIL_PATH) {
      const hydrated: Record<string, unknown>[] = [];
      for (const po of summaries) {
        const poNo = pickPoNo(po);
        if (!poNo) { hydrated.push(po); continue; }
        try {
          const lines = await client.getPurchaseOrderDetail(poNo);
          hydrated.push({ ...po, line_items: lines });
        } catch {
          hydrated.push(po); // keep header even if detail fails
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
  // ingestLiveInstamartPOs maps API fields directly (no field-name resolver), guarantees
  // a valid skuId for every line, and creates a summary line when the API returns headers only.
  const summary = await ingestLiveInstamartPOs(pos, opts.actorLabel ?? "Instamart sync");
  summary.fileName = fileName; // patch the live-ingest generic name with the actual window

  return { since, until, fileName, summary };
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

/** Best-effort dig a PO identifier out of a summary object. */
function pickPoNo(po: Record<string, unknown>): string | null {
  for (const k of ["purchase_order_id", "po_number", "poNumber", "po_no", "poNo", "purchase_order_number", "po_id", "poId", "id"]) {
    const v = po[k];
    if (typeof v === "string" || typeof v === "number") {
      const s = String(v).trim();
      if (s) return s;
    }
  }
  return null;
}
