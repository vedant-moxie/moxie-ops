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
  // Default body shape captured from picker.swiggy.com/api/v1/searchPurchaseOrder.
  // Uses INSTAMART_BRAND_COMPANY_ID (SHA-1 internal hash) + epoch ms date filter.
  // Used when no template is configured AND as a resilient fallback when a
  // configured template is malformed (e.g. mangled while pasting env vars into a
  // deploy platform) — so a bad env value never breaks the sync.
  const defaultBody = (): Record<string, unknown> => ({
    filters: {
      "order_dates.release_date": toISTEpochMs(vars.since),
      "brand_company_id": env.INSTAMART_BRAND_COMPANY_ID,
      "selling_party.id": "",
    },
    pagination: { page_number: vars.page + 1, size: vars.pageSize },
    sort: [{ sort_by: "pending_qty", sort_order: "DESC" }],
    query: { id: "", "ship_to_party.name": "" },
  });

  // Normalize: trim + strip one layer of surrounding quotes (env editors sometimes
  // keep the quotes from a .env line, which would break JSON.parse).
  let tpl = (template ?? "").trim();
  if (
    tpl.length >= 2 &&
    ((tpl.startsWith("'") && tpl.endsWith("'")) || (tpl.startsWith('"') && tpl.endsWith('"')))
  ) {
    tpl = tpl.slice(1, -1).trim();
  }
  if (!tpl) return defaultBody();

  // Quote-stripping replacements: '"{foo}"' removes surrounding quotes so the
  // placeholder becomes a bare JSON integer/number instead of a string.
  // IMPORTANT: "{page}" injects the 1-based page number (page+1) because REST
  // APIs that use page_number fields are universally 1-based. Use {page} (no
  // surrounding quotes) if you need the raw 0-based loop variable.
  const filled = tpl
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
  try {
    const parsed = JSON.parse(filled) as unknown;
    if (isRecord(parsed)) return parsed;
    console.warn("[instamart] INSTAMART_PO_LIST_BODY is not a JSON object — using default body");
  } catch (err) {
    console.warn(
      `[instamart] INSTAMART_PO_LIST_BODY failed to parse (${err instanceof Error ? err.message : String(err)}) — ` +
        `using the built-in default body. Check the env var for stray quotes/spaces.`,
    );
  }
  return defaultBody();
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
   * Download the PDF for a single Instamart PO via the confirmed batch/generate endpoint.
   * Returns { content, filename } where filename ends in .pdf, or null if the API
   * returns a non-success response (warning logged; caller wraps in Promise.allSettled).
   */
  async downloadPoPdf(poId: string): Promise<{ content: Buffer; filename: string } | null> {
    return this.downloadPoDocument(poId, "pdf");
  }

  /**
   * Download the CSV for a single Instamart PO via the confirmed batch/generate endpoint.
   * Instamart exposes CSV (MIME_TYPE_CSV), not xlsx — returns filename ending in .csv.
   * Returns null on non-success (warning logged; caller wraps in Promise.allSettled).
   */
  async downloadPoExcel(poId: string): Promise<{ content: Buffer; filename: string } | null> {
    return this.downloadPoDocument(poId, "excel");
  }

  private async downloadPoDocument(
    poId: string,
    fmt: "pdf" | "excel",
  ): Promise<{ content: Buffer; filename: string } | null> {
    const ext = fmt === "pdf" ? "pdf" : "csv";

    // Env override: manually captured endpoint (set INSTAMART_PO_DOC_PATH from browser cURL)
    if (env.INSTAMART_PO_DOC_PATH) {
      const overrideUrl = env.INSTAMART_PO_DOC_PATH
        .replaceAll("{poId}", encodeURIComponent(poId))
        .replaceAll("{fmt}", fmt);
      const res = await fetch(overrideUrl, {
        method: "GET",
        headers: this.headers(),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401 || res.status === 403) {
        throw new InstamartAuthExpired(`auth expired on Instamart PO doc ${poId} (HTTP ${res.status})`);
      }
      if (!res.ok) {
        throw new InstamartAPIError(`INSTAMART_PO_DOC_PATH fetch failed: HTTP ${res.status} for PO ${poId}`);
      }
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json") || ct.includes("text/plain")) {
        const envBody = await res.json().catch(() => ({})) as unknown;
        const inner = peelInstamartEnvelope(envBody);
        const dlUrl = isRecord(inner) ? extractStringField(inner, ["signed_url", "download_url", "url", "document_url"]) : null;
        if (dlUrl) return this.fetchDocumentFromUrl(dlUrl, poId, ext);
        throw new InstamartAPIError(`INSTAMART_PO_DOC_PATH JSON without URL for PO ${poId}: ${JSON.stringify(inner).slice(0, 200)}`);
      }
      const overrideContent = Buffer.from(await res.arrayBuffer());
      const overrideFilename = parseInstamartContentDisposition(res.headers.get("content-disposition") ?? "") ?? `${poId}.${ext}`;
      return { content: overrideContent, filename: overrideFilename };
    }

    // Primary: POST https://picker.swiggy.com/api/v1/document/batch/generate
    // The response is SYNCHRONOUS — the presigned S3 URL is returned immediately in:
    //   body.document_generation_responses[n].document.document_url
    // where body.document_generation_responses[n].document.mime_type matches mimeType.
    // Fetch the S3 URL with a plain fetch (no auth — it is a presigned URL).
    const mimeType = fmt === "pdf" ? "MIME_TYPE_PDF" : "MIME_TYPE_CSV";
    const batchRes = await fetch("https://picker.swiggy.com/api/v1/document/batch/generate", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        document_entities: [{ entity_type: "ENTITY_TYPE_PURCHASE_ORDER", entity_id: poId }],
        mime_type: mimeType,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (batchRes.status === 401 || batchRes.status === 403) {
      throw new InstamartAuthExpired(`auth expired on Instamart batch/generate for PO ${poId} (HTTP ${batchRes.status})`);
    }
    if (!batchRes.ok) {
      const txt = (await batchRes.text()).slice(0, 300);
      throw new InstamartAPIError(`Instamart batch/generate failed: HTTP ${batchRes.status} ${txt}`);
    }

    const body = await batchRes.json() as unknown;

    if (!isRecord(body) || body.status_code !== 0) {
      console.warn(`[Instamart] batch/generate non-success for PO ${poId} (${mimeType}): ${JSON.stringify(body).slice(0, 300)}`);
      return null;
    }

    const responses = Array.isArray(body.document_generation_responses)
      ? (body.document_generation_responses as unknown[])
      : [];

    if (responses.length === 0) {
      console.warn(`[Instamart] batch/generate empty document_generation_responses for PO ${poId} (${mimeType})`);
      return null;
    }

    let documentUrl: string | null = null;
    for (const r of responses) {
      if (isRecord(r) && isRecord(r.document) && r.document.mime_type === mimeType) {
        const url = r.document.document_url;
        if (typeof url === "string" && url) {
          documentUrl = url;
          break;
        }
      }
    }

    if (!documentUrl) {
      console.warn(
        `[Instamart] batch/generate: no document_url for mime_type=${mimeType} in PO ${poId}. ` +
          `responses: ${JSON.stringify(responses).slice(0, 400)}`,
      );
      return null;
    }

    // Presigned S3 URL — fetch without auth headers
    return this.fetchDocumentFromUrl(documentUrl, poId, ext);
  }

  private async fetchDocumentFromUrl(
    url: string,
    poId: string,
    ext: string,
  ): Promise<{ content: Buffer; filename: string }> {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      throw new InstamartAPIError(`Instamart doc fetch failed: HTTP ${res.status} for PO ${poId}`);
    }
    const content = Buffer.from(await res.arrayBuffer());
    let filename = parseInstamartContentDisposition(res.headers.get("content-disposition") ?? "");
    if (!filename) {
      try { filename = new URL(url).pathname.split("/").pop() ?? ""; } catch { filename = ""; }
    }
    return { content, filename: filename || `${poId}.${ext}` };
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

  /**
   * Fetch per-SKU line items for a single Instamart PO from the portal's
   * `listPurchaseOrderLines` endpoint.
   *
   * Endpoint: POST https://picker.swiggy.com/api/v1/listPurchaseOrderLines
   * Auth:     abacus-token header (same JWT as all other Instamart calls)
   * Body:     { filters: { purchase_order_id, brand_company_id }, pagination: { page_number, size } }
   * Response: { status_code: 0, data: { purchase_order_lines: [...], total_records_count: N } }
   * Item fields: external_item_code, description, qty (+ tax/price breakdown objects)
   *
   * Returns the raw line-item array. Throws InstamartAuthExpired on 401/403;
   * InstamartAPIError on other failures. Callers should wrap in try/catch and
   * fall back to the summary line on error.
   */
  async listPurchaseOrderLines(poNo: string): Promise<Record<string, unknown>[]> {
    const PAGE_SIZE = 50;
    const allLines: Record<string, unknown>[] = [];

    for (let page = 1; page <= 20; page++) {
      const res = await this.req("https://picker.swiggy.com/api/v1/listPurchaseOrderLines", {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          filters: {
            purchase_order_id: poNo,
            brand_company_id: env.INSTAMART_BRAND_COMPANY_ID,
          },
          pagination: { page_number: page, size: PAGE_SIZE },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new InstamartAPIError(
          `listPurchaseOrderLines HTTP ${res.status} for PO ${poNo}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
        );
      }
      const json = (await res.json().catch(() => null)) as unknown;
      if (isRecord(json) && typeof json.status_code === "number" && json.status_code !== 0) {
        throw new InstamartAPIError(
          `listPurchaseOrderLines status_code=${json.status_code} for PO ${poNo}: ${String(json.message ?? "")}`,
        );
      }
      const batch = extractList(json);
      allLines.push(...batch);
      const totalCount =
        isRecord(json) && isRecord(json.data)
          ? Number((json.data as Record<string, unknown>).total_records_count ?? 0)
          : 0;
      if (batch.length < PAGE_SIZE || (totalCount > 0 && allLines.length >= totalCount)) break;
    }
    return allLines;
  }
}

// ── private helpers ────────────────────────────────────────────────────────────

function peelInstamartEnvelope(payload: unknown): unknown {
  if (isRecord(payload) && "data" in payload) return payload.data;
  return payload;
}

function extractStringField(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
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
    for (const k of [
      "purchase_order_lines", "purchaseOrderLines",
      "purchase_orders", "purchaseOrders", "orders", "pos", "po_list",
      "results", "items", "list", "records", "line_items", "lineItems",
    ]) {
      if (Array.isArray(root[k])) return (root[k] as unknown[]).filter(isRecord);
    }
    // Fallback: first array-valued field.
    for (const v of Object.values(root)) {
      if (Array.isArray(v) && v.every(isRecord)) return v as Record<string, unknown>[];
    }
  }
  return [];
}
