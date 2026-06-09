import "server-only";
import { env } from "@/lib/env";
import type { NykaaTokens } from "@/lib/integrations/nykaa/auth";

export class NykaaAPIError extends Error {}
export class NykaaAuthExpired extends Error {}

export interface PoListQuery {
  /** Inclusive lower bound (YYYY-MM-DD) on the PO date filter. */
  since: string;
  /** Inclusive upper bound (YYYY-MM-DD). */
  until: string;
  /** Page size hint for the grid endpoint. */
  pageSize?: number;
}

/** A raw PO record as returned by the Nykaa grid; mapped downstream in ingest. */
export type RawNykaaPo = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Build the POST body for the Nykaa PO endpoint from an optional template.
 * Substitutes {since} {until} {page} {pageSize} {offset}. Quote-stripping
 * variants ('"{page}"') emit bare integers. Falls back to the confirmed default
 * shape ({"page": <1-based>}) when no template is configured.
 */
function renderNykaaBody(
  template: string | undefined,
  vars: { since: string; until: string; page: number; pageSize: number; offset: number },
): Record<string, unknown> {
  if (!template) {
    // Nykaa's listing pages are 1-based and the page size is server-fixed at 10.
    return { page: vars.page + 1 };
  }
  const filled = template
    .replaceAll('"{page}"', String(vars.page + 1))
    .replaceAll('"{pageSize}"', String(vars.pageSize))
    .replaceAll('"{offset}"', String(vars.offset))
    .replaceAll("{since}", vars.since)
    .replaceAll("{until}", vars.until)
    .replaceAll("{page}", String(vars.page))
    .replaceAll("{pageSize}", String(vars.pageSize))
    .replaceAll("{offset}", String(vars.offset));
  const parsed = JSON.parse(filled) as unknown;
  if (!isRecord(parsed)) throw new NykaaAPIError("NYKAA_PO_LIST_BODY must be a JSON object");
  return parsed;
}

/** Pull the first array of objects out of a paged/enveloped JSON response. */
function extractRecords(payload: unknown, depth = 0): RawNykaaPo[] {
  if (depth > 6 || payload == null) return [];
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  if (isRecord(payload)) {
    for (const k of [
      "poList", "purchaseOrders", "pos", "orders", "items", "records", "results", "rows", "content", "data",
    ]) {
      const v = payload[k];
      if (Array.isArray(v) && v.some(isRecord)) return v.filter(isRecord);
    }
    for (const v of Object.values(payload)) {
      const r = extractRecords(v, depth + 1);
      if (r.length) return r;
    }
  }
  return [];
}

export class NykaaClient {
  constructor(private tokens: NykaaTokens) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
      "content-type": "application/json",
      origin: "https://seller.nykaa.com",
      referer: "https://seller.nykaa.com/",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      // Nykaa seller-portal authenticates with these two headers (NOT Authorization Bearer).
      "x-access-token": this.tokens.accessToken,
      "x-domain": this.tokens.domain || env.NYKAA_DOMAIN,
    };
    if (env.NYKAA_PORTAL_COOKIE) h.cookie = env.NYKAA_PORTAL_COOKIE;
    return h;
  }

  private async req(path: string, init: RequestInit): Promise<Response> {
    const url = path.startsWith("http") ? path : `${env.NYKAA_BASE_URL}${path}`;
    const res = await fetch(url, { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) } });
    if (res.status === 401 || res.status === 403) {
      throw new NykaaAuthExpired(`auth expired on ${path} (HTTP ${res.status})`);
    }
    return res;
  }

  /** Raw probe helper — returns status + truncated body (for endpoint discovery). */
  async raw(path: string, init: RequestInit = {}): Promise<{ status: number; text: string }> {
    const url = path.startsWith("http") ? path : `${env.NYKAA_BASE_URL}${path}`;
    const res = await fetch(url, { method: "GET", ...init, headers: { ...this.headers(), ...(init.headers ?? {}) } });
    return { status: res.status, text: (await res.text()).slice(0, 1200) };
  }

  /**
   * Fetch PO records issued within [since, until] from the seller-portal listing,
   * paging until the window is exhausted. Returns raw records mapped by ingest.
   *
   * Nykaa's listing (POST /seller-portal/api/v1/purchase-order/listing) is sorted
   * newest-first with a server-fixed page size of 10 and 1-based `page` paging;
   * the response envelope is { data: { data: [...], count: { all, … } } } with no
   * per-page hasNext flag. We therefore page forward and STOP as soon as a page's
   * issue_date drops below `since` (rolling window) — this bounds the work to the
   * recent window instead of crawling all ~56 pages, and keeps us under the
   * portal's 20-requests/minute limit (a small inter-page delay reinforces that).
   *
   * Supports GET (query-string) and POST (JSON body) via NYKAA_PO_LIST_METHOD;
   * the body/path come from NYKAA_PO_LIST_PATH / NYKAA_PO_LIST_BODY (with defaults).
   */
  async listPurchaseOrders(q: PoListQuery): Promise<RawNykaaPo[]> {
    const tpl = env.NYKAA_PO_LIST_PATH;
    if (!tpl) {
      throw new NykaaAPIError("NYKAA_PO_LIST_PATH not configured.");
    }
    const PAGE_SIZE = 10; // Nykaa's server-fixed page size
    const MAX_PAGES = 120; // safety cap (well above ~56 pages for the full history)
    const INTER_PAGE_DELAY_MS = 400; // stay comfortably under 20 req/min
    const all: RawNykaaPo[] = [];
    const usesPost = env.NYKAA_PO_LIST_METHOD === "POST" || /__POST__/.test(tpl);
    const basePath = tpl.replace("__POST__", "");

    const issueDateOf = (po: RawNykaaPo): string | null => {
      const v = po.issue_date ?? po.issueDate ?? po.poDate ?? po.createDate;
      return typeof v === "string" ? v.slice(0, 10) : null;
    };

    for (let page = 0; page < MAX_PAGES; page++) {
      const filled = basePath
        .replaceAll("{since}", q.since)
        .replaceAll("{until}", q.until)
        .replaceAll("{page}", String(page))
        .replaceAll("{pageSize}", String(PAGE_SIZE));

      let res: Response;
      if (usesPost) {
        const body = renderNykaaBody(env.NYKAA_PO_LIST_BODY, {
          since: q.since,
          until: q.until,
          page,
          pageSize: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        });
        res = await this.req(filled, { method: "POST", body: JSON.stringify(body) });
      } else {
        res = await this.req(filled, { method: "GET" });
      }
      if (!res.ok) {
        throw new NykaaAPIError(`PO list ${filled} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      }
      const json = (await res.json().catch(() => null)) as unknown;
      const records = extractRecords(json);
      if (records.length === 0) break;

      // Keep rows inside the [since, until] window; detect when we've paged past it.
      let pagedPastWindow = false;
      for (const po of records) {
        const d = issueDateOf(po);
        if (d && d < q.since) {
          pagedPastWindow = true; // newest-first → everything after this is older too
          continue;
        }
        if (d && d > q.until) continue; // future-dated (rare) — skip but keep paging
        all.push(po);
      }

      if (pagedPastWindow) break; // reached POs older than the window
      if (records.length < PAGE_SIZE) break; // last page
      await new Promise((r) => setTimeout(r, INTER_PAGE_DELAY_MS));
    }
    return all;
  }

  /**
   * Optionally fetch line items for a single PO when the grid only returns
   * headers. Path template uses {poId}. Returns raw line records.
   */
  async fetchPoLineItems(poId: string): Promise<RawNykaaPo[]> {
    const tpl = env.NYKAA_PO_DETAIL_PATH;
    if (!tpl) return [];
    const path = tpl.replaceAll("{poId}", encodeURIComponent(poId));
    const res = await this.req(path, { method: "GET" });
    if (!res.ok) {
      throw new NykaaAPIError(`PO detail ${path} failed: HTTP ${res.status}`);
    }
    const json = (await res.json().catch(() => null)) as unknown;
    return extractRecords(json);
  }
}
