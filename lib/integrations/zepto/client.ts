import "server-only";
import { env } from "@/lib/env";
import type { ZeptoTokens } from "@/lib/integrations/zepto/auth";

export class ZeptoAPIError extends Error {}
export class ZeptoAuthExpired extends Error {}

export interface PoListQuery {
  /** Inclusive lower bound (YYYY-MM-DD) on the PO date filter. */
  since: string;
  /** Inclusive upper bound (YYYY-MM-DD). */
  until: string;
  /** Page size hint for the grid endpoint. */
  pageSize?: number;
}

/** A raw PO record as returned by the Zepto grid; mapped downstream in ingest. */
export type RawZeptoPo = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Convert YYYY-MM-DD to ISO timestamp at midnight IST (= previous day 18:30:00 UTC). */
function toZeptoISO(date: string, end = false): string {
  const parts = date.split("-").map(Number);
  const [y, m, d] = [parts[0]!, parts[1]!, parts[2]!];
  const ms = Date.UTC(y, m - 1, d) - 5.5 * 3_600_000 + (end ? 86_400_000 - 1 : 0);
  return new Date(ms).toISOString();
}

/**
 * Build the POST body for fcc.zepto.co.in/api/v1/po/filter from an optional template.
 * Substitutes {since} {until} {page} {pageSize} {offset} {sinceISO} {untilISO}.
 * Falls back to the captured default body shape (all statuses, offset pagination).
 */
function renderZeptoBody(
  template: string | undefined,
  vars: { since: string; until: string; page: number; pageSize: number; offset: number },
): Record<string, unknown> {
  if (!template) {
    // Default body shape captured from fcc.zepto.co.in/api/v1/po/filter.
    // Uses ISO timestamps (midnight/end-of-day IST) and offset-based pagination.
    return {
      vendorCodes: [],
      locationCodes: [],
      poStartDate: toZeptoISO(vars.since),
      poEndDate: toZeptoISO(vars.until, true),
      offset: vars.offset,
      limit: vars.pageSize,
      statusList: [], // empty = all statuses; portal default was ["PENDING_ACKNOWLEDGEMENT"]
      ids: [],
      scheduledStartDate: null,
      scheduledEndDate: null,
      expiryStartDate: null,
      expiryEndDate: null,
    };
  }
  // Quote-stripping replacements: '"{foo}"' removes surrounding JSON quotes so the
  // placeholder becomes a bare integer. "{page}" emits 1-based page number.
  const filled = template
    .replaceAll('"{page}"', String(vars.page + 1))    // 1-based page number (integer)
    .replaceAll('"{pageSize}"', String(vars.pageSize)) // integer
    .replaceAll('"{offset}"', String(vars.offset))     // integer
    .replaceAll("{sinceISO}", toZeptoISO(vars.since))
    .replaceAll("{untilISO}", toZeptoISO(vars.until, true))
    .replaceAll("{since}", vars.since)
    .replaceAll("{until}", vars.until)
    .replaceAll("{page}", String(vars.page))           // 0-based
    .replaceAll("{pageSize}", String(vars.pageSize))
    .replaceAll("{offset}", String(vars.offset));
  const parsed = JSON.parse(filled) as unknown;
  if (!isRecord(parsed)) throw new ZeptoAPIError("ZEPTO_PO_LIST_BODY must be a JSON object");
  return parsed;
}

/** Pull the first array of objects out of a paged/enveloped JSON response. */
function extractRecords(payload: unknown, depth = 0): RawZeptoPo[] {
  if (depth > 6 || payload == null) return [];
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  if (isRecord(payload)) {
    // Common list keys first, then any nested array of objects.
    for (const k of ["poList", "purchaseOrders", "pos", "orders", "items", "records", "results", "rows", "content", "data"]) {
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

export class ZeptoClient {
  constructor(private tokens: ZeptoTokens) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9,hi;q=0.8",
      "content-type": "application/json",
      origin: "https://brands.zepto.co.in",
      referer: "https://brands.zepto.co.in/",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      // fcc.zepto.co.in expects the raw HS256 jwtToken with NO "Bearer " prefix.
      authorization: this.tokens.accessToken,
      // brands.zepto.co.in sends this proxy header; include it for compatibility.
      "x-proxy-target": "brand-analytics",
    };
    // x-aws-waf-token is browser-minted — probing confirmed it is NOT required for
    // server-to-server requests. ZEPTO_PORTAL_COOKIE kept as optional fallback.
    if (env.ZEPTO_PORTAL_COOKIE) h.cookie = env.ZEPTO_PORTAL_COOKIE;
    return h;
  }

  private async req(path: string, init: RequestInit): Promise<Response> {
    const url = path.startsWith("http") ? path : `${env.ZEPTO_BASE_URL}${path}`;
    const res = await fetch(url, { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) } });
    if (res.status === 401 || res.status === 403) {
      throw new ZeptoAuthExpired(`auth expired on ${path} (HTTP ${res.status})`);
    }
    return res;
  }

  /** Raw probe helper — returns status + truncated body (for endpoint discovery). */
  async raw(path: string, init: RequestInit = {}): Promise<{ status: number; text: string }> {
    const url = path.startsWith("http") ? path : `${env.ZEPTO_BASE_URL}${path}`;
    const res = await fetch(url, { method: "GET", ...init, headers: { ...this.headers(), ...(init.headers ?? {}) } });
    return { status: res.status, text: (await res.text()).slice(0, 1200) };
  }

  /**
   * Fetch all PO records in [since, until] from the configured grid endpoint,
   * paging until exhausted. Returns raw records to be mapped by the ingest.
   *
   * The exact path/params come from the captured grid XHR (ZEPTO_PO_LIST_PATH);
   * until that's set this throws a clear, actionable error. Both query-string
   * and JSON-body filter shapes are supported via ZEPTO_PO_LIST_PATH containing
   * (or omitting) a `?`.
   */
  async listPurchaseOrders(q: PoListQuery): Promise<RawZeptoPo[]> {
    const tpl = env.ZEPTO_PO_LIST_PATH;
    if (!tpl) {
      throw new ZeptoAPIError(
        "ZEPTO_PO_LIST_PATH not configured — capture the PO-grid XHR (Copy as cURL) from " +
          "partner.zepto.co.in and set the endpoint path. The client + pagination are ready; " +
          "only the endpoint + filter param names are missing.",
      );
    }
    const pageSize = q.pageSize ?? 100;
    const all: RawZeptoPo[] = [];
    // POST when ZEPTO_PO_LIST_METHOD=POST (fcc.zepto.co.in/api/v1/po/filter is POST) or
    // the legacy __POST__ marker is embedded in the path. The path may be a full URL on
    // a different host than the auth host — req() respects an absolute URL as-is.
    const usesPost = env.ZEPTO_PO_LIST_METHOD === "POST" || /__POST__/.test(tpl);
    const basePath = tpl.replace("__POST__", "");

    for (let page = 0; page < 200; page++) {
      const filled = basePath
        .replaceAll("{since}", q.since)
        .replaceAll("{until}", q.until)
        .replaceAll("{page}", String(page))
        .replaceAll("{pageSize}", String(pageSize));

      let res: Response;
      if (usesPost) {
        // Use the captured body template when provided (placeholders {since}/{until}/
        // {page}/{pageSize}/{offset}); else a sensible default filter+pagination shape.
        const body = renderZeptoBody(env.ZEPTO_PO_LIST_BODY, {
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
        throw new ZeptoAPIError(`PO list ${filled} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      }
      const json = (await res.json().catch(() => null)) as unknown;
      const records = extractRecords(json);
      all.push(...records);
      if (records.length === 0 || records.length < pageSize) {
        if (!hasNextPage(json, page)) break;
      }
      if (!hasNextPage(json, page) && records.length < pageSize) break;
    }
    return all;
  }

  /**
   * Download the PDF for a single Zepto PO.
   *
   * Tries (in order):
   *   1. ZEPTO_PO_DOC_PATH env var with {poId}/{fmt} substituted (override for when
   *      the exact endpoint is captured from the brands.zepto.co.in portal).
   *   2. GET /api/v1/po/{poId}/download?type=pdf  (most common Zepto pattern)
   *   3. GET /api/v1/po/{poId}/pdf
   *
   * Handles both direct binary responses and JSON envelopes with signed_url/download_url.
   * Throws ZeptoAuthExpired on 401/403. Returns null (never throws) for format errors —
   * callers should treat a rejection as "unavailable" and continue without this attachment.
   */
  async downloadPoPdf(poId: string): Promise<{ content: Buffer; filename: string }> {
    return this.downloadPoDocument(poId, "pdf");
  }

  /**
   * Download the Excel for a single Zepto PO.
   * Same endpoint probing as downloadPoPdf; substitutes type=excel.
   */
  async downloadPoExcel(poId: string): Promise<{ content: Buffer; filename: string }> {
    return this.downloadPoDocument(poId, "excel");
  }

  private async downloadPoDocument(
    poId: string,
    fmt: "pdf" | "excel",
  ): Promise<{ content: Buffer; filename: string }> {
    const timeout = AbortSignal.timeout(15_000);

    // Build the list of candidate URLs to try in order.
    const candidates: string[] = [];

    if (env.ZEPTO_PO_DOC_PATH) {
      // Operator-supplied override (set this from a browser-captured cURL).
      candidates.push(
        env.ZEPTO_PO_DOC_PATH
          .replaceAll("{poId}", encodeURIComponent(poId))
          .replaceAll("{fmt}", fmt),
      );
    }

    // Probed paths on fcc.zepto.co.in (most likely based on API structure).
    const base = env.ZEPTO_BASE_URL; // https://fcc.zepto.co.in
    candidates.push(
      `${base}/api/v1/po/${encodeURIComponent(poId)}/download?type=${fmt}`,
      `${base}/api/v1/po/${encodeURIComponent(poId)}/${fmt}`,
      `${base}/api/v1/po-document/${encodeURIComponent(poId)}?format=${fmt}`,
    );

    let lastErr = "";
    for (const url of candidates) {
      let res: Response;
      try {
        res = await fetch(url, { method: "GET", headers: this.headers(), signal: timeout });
      } catch (err) {
        lastErr = String(err);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new ZeptoAuthExpired(`auth expired on Zepto PO doc ${poId} (HTTP ${res.status})`);
      }
      if (res.status === 404 || res.status === 400) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) {
        lastErr = `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
        continue;
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json") || contentType.includes("text/plain")) {
        // JSON envelope: extract signed_url / download_url
        const body = await res.json().catch(() => ({})) as unknown;
        const inner = peelZeptoEnvelope(body);
        const downloadUrl = isRecord(inner)
          ? (inner.signed_url ?? inner.download_url ?? inner.url ?? null)
          : null;
        if (typeof downloadUrl === "string" && downloadUrl) {
          const s3 = await fetch(downloadUrl, { signal: AbortSignal.timeout(15_000) });
          if (!s3.ok) throw new ZeptoAPIError(`Zepto PO ${fmt} S3 fetch failed: HTTP ${s3.status}`);
          const content = Buffer.from(await s3.arrayBuffer());
          const filename =
            parseZeptoContentDisposition(s3.headers.get("content-disposition") ?? "") ??
            new URL(downloadUrl).pathname.split("/").pop() ??
            `${poId}.${fmt}`;
          return { content, filename };
        }
        // JSON body without a download URL — this endpoint exists but doesn't expose docs
        lastErr = `JSON response without signed_url/download_url: ${JSON.stringify(inner).slice(0, 200)}`;
        continue;
      }

      // Direct binary response
      const content = Buffer.from(await res.arrayBuffer());
      const filename =
        parseZeptoContentDisposition(res.headers.get("content-disposition") ?? "") ??
        `${poId}.${fmt}`;
      return { content, filename };
    }

    throw new ZeptoAPIError(
      `Zepto PO ${fmt} not available for PO ${poId}. ` +
        `None of the probed endpoints returned a document (last: ${lastErr}). ` +
        `To unlock: open brands.zepto.co.in → PO ${poId} → "Download PO" → Copy as cURL ` +
        `and set ZEPTO_PO_DOC_PATH to the endpoint path.`,
    );
  }

  /**
   * Optionally fetch line items for a single PO when the grid only returns
   * headers. Path template uses {poId}. Returns raw line records.
   */
  async fetchPoLineItems(poId: string): Promise<RawZeptoPo[]> {
    const tpl = env.ZEPTO_PO_DETAIL_PATH;
    if (!tpl) return [];
    const path = tpl.replaceAll("{poId}", encodeURIComponent(poId));
    const res = await this.req(path, { method: "GET" });
    if (!res.ok) {
      throw new ZeptoAPIError(`PO detail ${path} failed: HTTP ${res.status}`);
    }
    const json = (await res.json().catch(() => null)) as unknown;
    return extractRecords(json);
  }
}

// ── private helpers ────────────────────────────────────────────────────────────

function peelZeptoEnvelope(payload: unknown): unknown {
  if (isRecord(payload) && "data" in payload) return payload.data;
  return payload;
}

const ZEPTO_CD_RE = /filename\*?=(?:"([^"]+)"|([^;]+))/i;
function parseZeptoContentDisposition(header: string): string | null {
  if (!header) return null;
  const m = header.match(ZEPTO_CD_RE);
  if (!m) return null;
  let raw = (m[1] || m[2] || "").trim();
  if (raw.toLowerCase().startsWith("utf-8''")) raw = decodeURIComponent(raw.slice(7));
  return raw || null;
}
