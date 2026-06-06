import "server-only";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import type { InstamartTokens } from "@/lib/integrations/instamart/auth";

export class InstamartAPIError extends Error {}
export class InstamartAuthExpired extends Error {}
/** Thrown when a PO data endpoint hasn't been configured/discovered yet. */
export class InstamartEndpointUnknown extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Convert YYYY-MM-DD to epoch milliseconds at midnight IST (UTC+5:30). */
function toISTEpochMs(date: string, end = false): number {
  // IST = UTC+5:30; midnight IST = previous day 18:30:00 UTC
  const parts = date.split("-").map(Number);
  const [y, m, d] = [parts[0]!, parts[1]!, parts[2]!];
  const ms = Date.UTC(y, m - 1, d) - 5.5 * 3_600_000;
  return end ? ms + 86_400_000 - 1 : ms;
}

/** Convert YYYY-MM-DD to ISO timestamp at midnight IST (UTC+5:30). */
function toISTIso(date: string, end = false): string {
  const ms = toISTEpochMs(date, end);
  return new Date(ms).toISOString().replace(/\.000Z$/, ".000Z");
}

/**
 * Build a POST body from an optional JSON template. Substitutes:
 *   {since} {until}         — YYYY-MM-DD date strings
 *   {page} {pageSize} {offset} — numeric (also '"{x}"' for JSON-number coercion)
 *   {sinceEpochMs} {untilEpochMs} — epoch ms at midnight/end-of-day IST
 *   {sinceISO} {untilISO}   — ISO timestamp strings at midnight/end-of-day IST
 * Falls back to the captured default body shape when no template is configured.
 */
function renderBodyTemplate(
  template: string | undefined,
  vars: { since: string; until: string; page: number; pageSize: number; offset: number },
): Record<string, unknown> {
  if (!template) {
    // Default body shape captured from picker.swiggy.com/api/v1/searchPurchaseOrder.
    // Uses INSTAMART_BRAND_COMPANY_ID (SHA-1 internal hash) + epoch ms date filter.
    return {
      filters: {
        "order_dates.release_date": toISTEpochMs(vars.since),
        "brand_company_id": env.INSTAMART_BRAND_COMPANY_ID,
        "selling_party.id": "",
      },
      pagination: { page_number: vars.page + 1, size: vars.pageSize },
      sort: [{ sort_by: "pending_qty", sort_order: "DESC" }],
      query: { id: "", "ship_to_party.name": "" },
    };
  }
  // Quote-stripping replacements: '"{foo}"' removes surrounding quotes so the
  // placeholder becomes a bare JSON integer/number instead of a string.
  // IMPORTANT: "{page}" injects the 1-based page number (page+1) because REST
  // APIs that use page_number fields are universally 1-based. Use {page} (no
  // surrounding quotes) if you need the raw 0-based loop variable.
  const filled = template
    .replaceAll('"{page}"', String(vars.page + 1))    // 1-based page number (integer)
    .replaceAll('"{pageSize}"', String(vars.pageSize)) // integer
    .replaceAll('"{offset}"', String(vars.offset))     // integer
    .replaceAll("{sinceEpochMs}", String(toISTEpochMs(vars.since)))
    .replaceAll("{untilEpochMs}", String(toISTEpochMs(vars.until, true)))
    .replaceAll("{sinceISO}", toISTIso(vars.since))
    .replaceAll("{untilISO}", toISTIso(vars.until, true))
    .replaceAll("{since}", vars.since)
    .replaceAll("{until}", vars.until)
    .replaceAll("{page}", String(vars.page))           // 0-based (for custom offset math)
    .replaceAll("{pageSize}", String(vars.pageSize))
    .replaceAll("{offset}", String(vars.offset));
  const parsed = JSON.parse(filled) as unknown;
  if (!isRecord(parsed)) throw new InstamartAPIError("INSTAMART_PO_LIST_BODY must be a JSON object");
  return parsed;
}

/**
 * Client for the Swiggy Instamart brand/seller portal data APIs. Authenticates
 * with the OTP access_token in the `abacus-token` header (NOT Authorization:
 * Bearer). The PO search endpoint lives on picker.swiggy.com (POST) and
 * authorizes off the same ozone-idp JWT our OTP login produces.
 *
 * The PO list endpoint and POST body are configured via env:
 *   INSTAMART_PO_LIST_PATH   — full URL (defaults to picker.swiggy.com endpoint)
 *   INSTAMART_PO_LIST_METHOD — GET or POST (default POST)
 *   INSTAMART_PO_LIST_BODY   — JSON template; placeholders {since}/{until}/{page}/{pageSize}/{offset}
 *   INSTAMART_ACCOUNT_ID     — brandCompanyId / supplierId from the ozone-idp JWT
 */
export class InstamartClient {
  constructor(private tokens: InstamartTokens) {}

  private headers(): Record<string, string> {
    return {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
      app_version: env.INSTAMART_APP_VERSION,
      // The picker.swiggy.com PO endpoint authorizes off the `abacus-token` custom
      // header (same JWT our OTP login produces — NOT a Bearer token).
      "abacus-token": this.tokens.accessToken,
      "content-type": "application/json",
      origin: "https://partner.instamart.in",
      referer: "https://partner.instamart.in/",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "x-client-request-id": randomUUID(),
      "x-timestamp": Date.now().toString(),
    };
  }

  private url(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return `${env.INSTAMART_API_BASE_URL.replace(/\/$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
  }

  private async req(path: string, init: RequestInit): Promise<Response> {
    const res = await fetch(this.url(path), init);
    if (res.status === 401 || res.status === 403) {
      throw new InstamartAuthExpired(`auth expired on ${path} (HTTP ${res.status})`);
    }
    return res;
  }

  /** Raw request returning status + body text — for discovering/diagnosing endpoints. */
  async probe(path: string, init: RequestInit = {}): Promise<{ status: number; text: string }> {
    const res = await fetch(this.url(path), { method: "GET", ...init, headers: { ...this.headers(), ...(init.headers ?? {}) } });
    return { status: res.status, text: (await res.text()).slice(0, 1500) };
  }

  async getJson(path: string, query?: Record<string, string | number>): Promise<unknown> {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}` : "";
    const res = await this.req(`${path}${qs}`, { method: "GET", headers: this.headers() });
    if (!res.ok) throw new InstamartAPIError(`GET ${path} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json().catch(() => ({}));
  }

  async postJson(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await this.req(path, { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new InstamartAPIError(`POST ${path} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json().catch(() => ({}));
  }

  /**
   * Page the PO-listing endpoint and return raw PO summary objects for the window.
   *
   * Defaults to POST picker.swiggy.com/api/v1/searchPurchaseOrder with abacus-token
   * auth and a body that includes brandCompanyId (INSTAMART_ACCOUNT_ID).
   * Override via INSTAMART_PO_LIST_PATH / INSTAMART_PO_LIST_METHOD / INSTAMART_PO_LIST_BODY
   * if the portal returns a different endpoint or body shape.
   */
  /**
   * Page the PO-listing endpoint and return raw PO summary objects for the window.
   *
   * Defaults to POST picker.swiggy.com/api/v1/searchPurchaseOrder with abacus-token
   * auth. The default body uses integer pagination (page_number: N, size: 50) and a
   * single epoch lower-bound for order_dates.release_date (confirmed working via live
   * probe — returns all POs on or after that date). Override body shape via
   * INSTAMART_PO_LIST_BODY (placeholders: {since}/{until}/{page}/{pageSize}/{offset},
   * or "{page}"/{pageSize}" for integer injection into JSON strings).
   *
   * Throws InstamartAPIError if the API body contains status_code != 0.
   */
  async listPurchaseOrders(opts: { since: string; until: string; pageSize?: number; maxPages?: number }): Promise<Record<string, unknown>[]> {
    const path = env.INSTAMART_PO_LIST_PATH;
    if (!path) {
      throw new InstamartEndpointUnknown(
        "INSTAMART_PO_LIST_PATH is not set. Capture the PO grid XHR from the logged-in " +
          "Swiggy Instamart Ads Portal (Network > Fetch/XHR > Copy as cURL) and set the path.",
      );
    }
    const pageSize = opts.pageSize ?? 50;
    const maxPages = opts.maxPages ?? 200;
    const usePost = env.INSTAMART_PO_LIST_METHOD === "POST";
    const out: Record<string, unknown>[] = [];
    let total: number | null = null;

    for (let page = 0; page < maxPages; page++) {
      const vars = { since: opts.since, until: opts.until, page, pageSize, offset: page * pageSize };
      let payload: unknown;
      if (usePost) {
        const body = renderBodyTemplate(env.INSTAMART_PO_LIST_BODY, vars);
        const res = await this.req(path, { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
        if (!res.ok) {
          const txt = (await res.text()).slice(0, 400);
          throw new InstamartAPIError(`POST ${path} failed: HTTP ${res.status} ${txt}`);
        }
        payload = await res.json().catch(() => ({}));
        // Swiggy encodes errors as HTTP 200 with status_code:1 in body
        if (isRecord(payload) && typeof payload.status_code === "number" && payload.status_code !== 0) {
          throw new InstamartAPIError(
            `POST ${path} API error: status_code=${payload.status_code} message=${String(payload.message ?? "")}`
          );
        }
      } else {
        payload = await this.getJson(path, { offset: page * pageSize, limit: pageSize, start_date: opts.since, end_date: opts.until });
      }

      // Extract total on first page for smarter stopping
      if (page === 0 && isRecord(payload)) {
        const data = isRecord(payload.data) ? payload.data : payload;
        const t = data.total_number_of_purchase_order_records ?? data.total ?? data.totalCount;
        if (typeof t === "number") total = t;
      }

      const batch = extractList(payload);
      out.push(...batch);

      const fetched = out.length;
      if (batch.length < pageSize) break;
      if (total !== null && fetched >= total) break;
    }
    return out;
  }

  /**
   * Download the PDF for a single Instamart PO.
   *
   * Tries (in order):
   *   1. INSTAMART_PO_DOC_PATH env var with {poId}/{fmt} substituted (override).
   *   2. GET picker.swiggy.com/api/v1/purchaseOrderDocument/{poId}/download?format=pdf
   *   3. GET picker.swiggy.com/api/v1/purchaseOrder/{poId}/pdf
   *   4. GET partner.instamart.in/api/v1/purchaseOrder/{poId}/pdf
   *
   * Handles direct binary and JSON envelope (signed_url/download_url).
   * Throws InstamartAuthExpired on 401/403.
   */
  async downloadPoPdf(poId: string): Promise<{ content: Buffer; filename: string }> {
    return this.downloadPoDocument(poId, "pdf");
  }

  /**
   * Download the Excel for a single Instamart PO.
   * Same endpoint probing as downloadPoPdf; substitutes format=excel.
   */
  async downloadPoExcel(poId: string): Promise<{ content: Buffer; filename: string }> {
    return this.downloadPoDocument(poId, "excel");
  }

  private async downloadPoDocument(
    poId: string,
    fmt: "pdf" | "excel",
  ): Promise<{ content: Buffer; filename: string }> {
    const timeout = AbortSignal.timeout(15_000);

    const candidates: string[] = [];

    if (env.INSTAMART_PO_DOC_PATH) {
      candidates.push(
        env.INSTAMART_PO_DOC_PATH
          .replaceAll("{poId}", encodeURIComponent(poId))
          .replaceAll("{fmt}", fmt),
      );
    }

    // Probed paths on picker.swiggy.com and partner.instamart.in.
    const pickerBase = "https://picker.swiggy.com";
    candidates.push(
      `${pickerBase}/api/v1/purchaseOrderDocument/${encodeURIComponent(poId)}/download?format=${fmt}`,
      `${pickerBase}/api/v1/purchaseOrder/${encodeURIComponent(poId)}/${fmt}`,
      `https://partner.instamart.in/api/v1/purchaseOrder/${encodeURIComponent(poId)}/${fmt}`,
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
        throw new InstamartAuthExpired(`auth expired on Instamart PO doc ${poId} (HTTP ${res.status})`);
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
        const body = await res.json().catch(() => ({})) as unknown;
        const inner = peelInstamartEnvelope(body);
        const downloadUrl = isRecord(inner)
          ? (inner.signed_url ?? inner.download_url ?? inner.url ?? null)
          : null;
        if (typeof downloadUrl === "string" && downloadUrl) {
          const s3 = await fetch(downloadUrl, { signal: AbortSignal.timeout(15_000) });
          if (!s3.ok) throw new InstamartAPIError(`Instamart PO ${fmt} S3 fetch failed: HTTP ${s3.status}`);
          const content = Buffer.from(await s3.arrayBuffer());
          const filename =
            parseInstamartContentDisposition(s3.headers.get("content-disposition") ?? "") ??
            new URL(downloadUrl).pathname.split("/").pop() ??
            `${poId}.${fmt}`;
          return { content, filename };
        }
        lastErr = `JSON response without signed_url/download_url: ${JSON.stringify(inner).slice(0, 200)}`;
        continue;
      }

      // Direct binary response
      const content = Buffer.from(await res.arrayBuffer());
      const filename =
        parseInstamartContentDisposition(res.headers.get("content-disposition") ?? "") ??
        `${poId}.${fmt}`;
      return { content, filename };
    }

    throw new InstamartAPIError(
      `Instamart PO ${fmt} not available for PO ${poId}. ` +
        `None of the probed endpoints returned a document (last: ${lastErr}). ` +
        `To unlock: open partner.instamart.in → PO ${poId} → "Download PO" → Copy as cURL ` +
        `and set INSTAMART_PO_DOC_PATH to the endpoint path.`,
    );
  }

  /** Fetch the per-PO line items. Scaffold: wire the captured detail path/shape. */
  async getPurchaseOrderDetail(poNo: string): Promise<Record<string, unknown>[]> {
    const path = env.INSTAMART_PO_DETAIL_PATH;
    if (!path) {
      throw new InstamartEndpointUnknown(
        "INSTAMART_PO_DETAIL_PATH is not set. Capture the per-PO line-item XHR from the portal " +
          "and set the path (use {poNo} as a placeholder for the PO identifier).",
      );
    }
    const resolved = path.replace("{poNo}", encodeURIComponent(poNo));
    const payload = await this.getJson(resolved);
    return extractList(payload);
  }
}

// ── private helpers ────────────────────────────────────────────────────────────

function peelInstamartEnvelope(payload: unknown): unknown {
  if (isRecord(payload) && "data" in payload) return payload.data;
  return payload;
}

const INSTAMART_CD_RE = /filename\*?=(?:"([^"]+)"|([^;]+))/i;
function parseInstamartContentDisposition(header: string): string | null {
  if (!header) return null;
  const m = header.match(INSTAMART_CD_RE);
  if (!m) return null;
  let raw = (m[1] || m[2] || "").trim();
  if (raw.toLowerCase().startsWith("utf-8''")) raw = decodeURIComponent(raw.slice(7));
  return raw || null;
}

/**
 * Pull the array of records out of a Swiggy JSON envelope. Swiggy commonly wraps
 * as { statusCode, statusMessage, data: { ... } } with the list under a nested
 * key. We hunt the likely containers, else the first array we find.
 */
function extractList(payload: unknown): Record<string, unknown>[] {
  const root = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  if (Array.isArray(root)) return root.filter(isRecord);
  if (isRecord(root)) {
    for (const k of ["purchase_orders", "purchaseOrders", "orders", "pos", "po_list", "results", "items", "list", "records", "line_items", "lineItems"]) {
      if (Array.isArray(root[k])) return (root[k] as unknown[]).filter(isRecord);
    }
    // Fallback: first array-valued field.
    for (const v of Object.values(root)) {
      if (Array.isArray(v) && v.every(isRecord)) return v as Record<string, unknown>[];
    }
  }
  return [];
}
