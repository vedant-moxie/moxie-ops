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
 * variants ('"{page}"') emit bare integers. Falls back to a minimal default
 * shape when no template is configured.
 */
function renderNykaaBody(
  template: string | undefined,
  vars: { since: string; until: string; page: number; pageSize: number; offset: number },
): Record<string, unknown> {
  if (!template) {
    return {
      startDate: vars.since,
      endDate: vars.until,
      page: vars.page,
      pageSize: vars.pageSize,
      offset: vars.offset,
    };
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

/** Best-effort total-pages / has-next detection from a paged envelope. */
function hasNextPage(payload: unknown, page: number): boolean {
  if (!isRecord(payload)) return false;
  const dig = (obj: Record<string, unknown>): boolean | null => {
    for (const k of ["hasNext", "hasMore", "has_next", "hasNextPage"]) {
      if (typeof obj[k] === "boolean") return obj[k] as boolean;
    }
    const totalPages = obj.totalPages ?? obj.total_pages ?? obj.pageCount;
    if (typeof totalPages === "number") return page + 1 < totalPages;
    return null;
  };
  const top = dig(payload);
  if (top != null) return top;
  for (const k of ["data", "result", "page", "pagination", "meta"]) {
    const nested = payload[k];
    if (isRecord(nested)) {
      const r = dig(nested);
      if (r != null) return r;
    }
  }
  return false;
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
   * Download the PO documents bundle (a ZIP containing the PO PDF/details) from
   * the seller-portal download endpoint. Authenticated with the same x-access-token
   * / x-domain headers. Returns the binary + the server-provided filename.
   */
  async downloadPoZip(poNumber: string): Promise<{ content: Buffer; filename: string }> {
    const url =
      `https://api-seller.nykaa.com/seller-portal/api/v1/download/po-grn-rtv-appointments-pdf` +
      `?type=po&entityNumber=${encodeURIComponent(poNumber)}`;
    const res = await this.req(url, { method: "GET", headers: { accept: "application/json, text/plain, */*" } });
    if (!res.ok) throw new Error(`Nykaa PO-doc download failed: HTTP ${res.status}`);
    const content = Buffer.from(await res.arrayBuffer());
    // Nykaa exposes the name in a `filename` response header (it's CORS-exposed).
    const header = res.headers.get("filename") ?? "";
    const cd = res.headers.get("content-disposition") ?? "";
    const cdMatch = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    const filename = header || (cdMatch ? decodeURIComponent(cdMatch[1]!.replace(/"/g, "")) : `PODetails_${poNumber}.zip`);
    return { content, filename };
  }

  /**
   * Fetch all PO records in [since, until] from the configured grid endpoint,
   * paging until exhausted. Returns raw records to be mapped by the ingest.
   *
   * The exact path/params come from the captured grid XHR (NYKAA_PO_LIST_PATH);
   * the nykka-simulate bundle only exposed the sales-report download endpoint,
   * so the PO-grid endpoint must be captured from seller.nykaa.com (Copy as cURL)
   * and set here. The client + pagination are ready; only the endpoint + filter
   * param names are missing. Supports both GET (query-string) and POST (JSON body)
   * shapes via NYKAA_PO_LIST_METHOD.
   */
  async listPurchaseOrders(q: PoListQuery): Promise<RawNykaaPo[]> {
    const tpl = env.NYKAA_PO_LIST_PATH;
    if (!tpl) {
      throw new NykaaAPIError(
        "NYKAA_PO_LIST_PATH not configured — capture the PO-grid XHR (Copy as cURL) from " +
          "seller.nykaa.com and set the endpoint path. Auth (2captcha + OTP) and pagination " +
          "are ready; only the endpoint + filter param names are missing.",
      );
    }
    // Nykaa's /listing is server-fixed at 10/page, newest-first, and does NOT
    // filter by date — so we page through and window client-side on issue_date
    // (YYYY-MM-DD, lexicographically comparable to since/until). Newest-first
    // means once we see a PO older than `since`, every later one is older too,
    // so we stop early instead of walking all ~540 pages.
    const pageSize = q.pageSize ?? 10;
    const all: RawNykaaPo[] = [];
    const usesPost = env.NYKAA_PO_LIST_METHOD === "POST" || /__POST__/.test(tpl);
    const basePath = tpl.replace("__POST__", "");
    const hasWindow = !!(q.since || q.until);
    const issueDateOf = (r: RawNykaaPo): string | null => {
      const v = r.issue_date ?? r.issueDate ?? r.po_date ?? r.createDate ?? r.created_at;
      return typeof v === "string" && v.length >= 10 ? v.slice(0, 10) : null;
    };

    for (let page = 0; page < 500; page++) {
      const filled = basePath
        .replaceAll("{since}", q.since)
        .replaceAll("{until}", q.until)
        .replaceAll("{page}", String(page))
        .replaceAll("{pageSize}", String(pageSize));

      let res: Response;
      if (usesPost) {
        const body = renderNykaaBody(env.NYKAA_PO_LIST_BODY, {
          since: q.since,
          until: q.until,
          page,
          pageSize,
          offset: page * pageSize,
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

      let reachedOlderThanWindow = false;
      for (const rec of records) {
        const d = hasWindow ? issueDateOf(rec) : null;
        if (d) {
          if (q.since && d < q.since) { reachedOlderThanWindow = true; continue; }
          if (q.until && d > q.until) continue; // newer than window (rare, newest-first)
        }
        all.push(rec);
      }

      if (reachedOlderThanWindow) break;     // past the window — all remaining are older
      if (records.length < pageSize) break;  // last page
      if (!usesPost && !/\{page\}/.test(basePath)) break; // GET w/o paging param: single shot
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
