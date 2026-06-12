import "server-only";
import { getTokens } from "@/lib/integrations/nykaa/auth";
import { NykaaClient, NykaaAuthExpired, type RawNykaaPo } from "@/lib/integrations/nykaa/client";
import { ingestLiveNykaaPOs, type IngestSummary } from "@/lib/services/nykaa-ingest";

const IST_OFFSET_MS = 5.5 * 3_600_000;
const PO_FETCH_CONCURRENCY = 10;
const PO_FETCH_TIMEOUT_MS = 10_000;

/** Run `fn` over `items` with at most `concurrency` in-flight at once. */
async function pooledMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

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
function findLineArray(po: RawNykaaPo): RawNykaaPo[] | null {
  for (const k of LINE_ARRAY_KEYS) {
    const v = po[k];
    if (Array.isArray(v) && v.some(isRecord)) return v.filter(isRecord);
  }
  return null;
}

/**
 * Live-scrape Nykaa POs for [since, until] (defaults: rolling 30-day window
 * through tomorrow IST so settled POs are visible), then ingest into the
 * pipeline. Re-authenticates once (2captcha + OTP) if the cached token expired.
 *
 * When the grid returns header-only rows and NYKAA_PO_DETAIL_PATH is set, each
 * PO is hydrated with per-SKU line items (bounded concurrency); otherwise ingest
 * falls back to a single summary line. Mirrors syncZepto.
 */
export async function syncNykaa(
  opts: { since?: string; until?: string; actorLabel?: string } = {},
): Promise<SyncResult> {
  const since = opts.since ?? istDaysAgo(30);
  const until = opts.until ?? istDaysAgo(-1);

  const runOnce = async (forceRefresh: boolean): Promise<RawNykaaPo[]> => {
    const tokens = await getTokens(forceRefresh);
    const client = new NykaaClient(tokens);
    const pos = await client.listPurchaseOrders({ since, until });

    // Hydrate header-only POs with per-SKU line items (bounded concurrency).
    await pooledMap(
      pos,
      async (po) => {
        if (findLineArray(po)) return;
        const poId = String(po.pocode ?? po.po_code ?? po.poNumber ?? po.po_number ?? po.poId ?? po.id ?? "");
        if (!poId) return;
        try {
          const items = await withTimeout(client.fetchPoLineItems(poId), PO_FETCH_TIMEOUT_MS);
          if (items.length) (po as Record<string, unknown>).items = items;
        } catch (err) {
          console.warn(`[nykaa-sync] items fetch failed for PO ${poId}: ${err instanceof Error ? err.message : err}`);
        }
      },
      PO_FETCH_CONCURRENCY,
    );
    return pos;
  };

  let pos: RawNykaaPo[];
  try {
    pos = await runOnce(false);
  } catch (err) {
    if (err instanceof NykaaAuthExpired) {
      pos = await runOnce(true); // token stale → re-login (2captcha + OTP) and retry once
    } else {
      throw err;
    }
  }

  const fileName = `nykaa-po-${since}_to_${until}.json`;
  const summary = await ingestLiveNykaaPOs(pos, opts.actorLabel ?? "Nykaa sync");
  summary.fileName = fileName;

  return { since, until, fileName, summary };
}
