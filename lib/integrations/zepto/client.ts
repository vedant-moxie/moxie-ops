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
   * The PO PDF is a pre-generated file in S3 (prod-nexus-svc-bucket, object key =
   * a document UUID). The brands portal lists it via the PO attachments endpoint,
   * which returns a SHORT-LIVED presigned S3 URL (X-Amz-Expires=300):
   *
   *   GET /api/v1/po/{poNo}/attachments
   *   → { data: [ { documentType: "PO_DOC", documentNumber, s3Url: "https://…amazonaws.com/…pdf?X-Amz-…" } ] }
   *
   * We then fetch that presigned URL with NO auth headers (presigned URLs are
   * self-authenticating) and return the PDF bytes.
   *
   * Probe order:
   *   1. ZEPTO_PO_DOC_PATH env var (operator override; {poId} → PO no).
   *   2. GET /api/v1/po/{poId}/attachments  — the live discovered endpoint.
   *
   * Each JSON response is parsed for an attachment s3Url, then scanned
   * recursively for any presigned S3 URL as a fallback.
   *
   * Throws ZeptoAuthExpired on 401/403. Throws ZeptoAPIError when no document is
   * found; callers use Promise.allSettled so this never reaches the allocate hot
   * path as an unhandled exception.
   */
  async downloadPoPdf(poId: string): Promise<{ content: Buffer; filename: string }> {
    const timeout = AbortSignal.timeout(15_000);
    const base = env.ZEPTO_BASE_URL;

    const candidates: string[] = [];
    if (env.ZEPTO_PO_DOC_PATH) {
      candidates.push(
        env.ZEPTO_PO_DOC_PATH
          .replaceAll("{poId}", encodeURIComponent(poId))
          .replaceAll("{fmt}", "pdf"),
      );
    }
    candidates.push(`${base}/api/v1/po/${encodeURIComponent(poId)}/attachments`);

    let lastStatus = "";
    for (const url of candidates) {
      let res: Response;
      try {
        res = await fetch(url, { method: "GET", headers: this.headers(), signal: timeout });
      } catch (err) {
        lastStatus = String(err);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new ZeptoAuthExpired(`auth expired on Zepto PDF for PO ${poId} (HTTP ${res.status})`);
      }
      if (!res.ok) {
        lastStatus = `HTTP ${res.status} on ${url.replace(base, "")}`;
        continue;
      }

      const ct = res.headers.get("content-type") ?? "";
      // Some override endpoints may stream the PDF directly.
      if (ct.includes("application/pdf")) {
        const content = Buffer.from(await res.arrayBuffer());
        return { content, filename: `${poId}.pdf` };
      }

      // Parse the attachments envelope first (PO_DOC entry), then fall back to a
      // recursive sweep for any presigned S3 URL embedded in the response.
      const rawText = await res.text();
      const presignedUrl = extractZeptoAttachmentUrl(rawText) ?? findZeptoS3PresignedUrl(rawText);
      if (presignedUrl) {
        // Presigned URLs are self-authenticating — send NO Zepto auth headers.
        const s3Res = await fetch(presignedUrl, { signal: AbortSignal.timeout(15_000) });
        if (!s3Res.ok) {
          throw new ZeptoAPIError(`Zepto PDF S3 fetch failed HTTP ${s3Res.status} for PO ${poId}`);
        }
        const content = Buffer.from(await s3Res.arrayBuffer());
        // S3 serves application/octet-stream with no content-disposition; force a
        // .pdf filename so downstream attachers tag it application/pdf.
        return { content, filename: `${poId}.pdf` };
      }
      lastStatus = `no S3 URL in response from ${url.replace(base, "")}: ${rawText.slice(0, 120)}`;
    }

    throw new ZeptoAPIError(
      `Zepto PDF not available for PO ${poId} (last: ${lastStatus}). ` +
        `Expected GET /api/v1/po/${poId}/attachments to return data[].s3Url. ` +
        `Set ZEPTO_PO_DOC_PATH to override the endpoint (use {poId} for the PO number).`,
    );
  }

  /**
   * Build a CSV for a single Zepto PO from the line-items JSON endpoint.
   *
   * There is no server-side CSV/Excel for Zepto POs — the brands portal builds
   * the spreadsheet client-side from the items endpoint. We replicate that here.
   *
   * Endpoint: GET /api/v1/po/{poId}/items?offset=0&limit=-1
   * Auth:     authorization header (same raw HS256 JWT as all other Zepto calls)
   *
   * Returns filename {poId}.csv. Throws ZeptoAuthExpired on 401/403.
   */
  async downloadPoExcel(poId: string): Promise<{ content: Buffer; filename: string }> {
    const timeout = AbortSignal.timeout(15_000);
    const url = `${env.ZEPTO_BASE_URL}/api/v1/po/${encodeURIComponent(poId)}/items?offset=0&limit=-1`;

    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers: this.headers(), signal: timeout });
    } catch (err) {
      throw new ZeptoAPIError(`Zepto items fetch failed for PO ${poId}: ${err}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ZeptoAuthExpired(`auth expired fetching Zepto items for PO ${poId} (HTTP ${res.status})`);
    }
    if (!res.ok) {
      throw new ZeptoAPIError(`Zepto items endpoint HTTP ${res.status} for PO ${poId}`);
    }

    const json = await res.json().catch(() => null) as unknown;
    const items = extractZeptoItemsList(json);
    const csv = buildZeptoCsv(poId, items);
    return { content: Buffer.from(csv, "utf-8"), filename: `${poId}.csv` };
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

  /**
   * Fetch per-SKU line items for a single PO from the Zepto items endpoint.
   *
   * Endpoint: GET /api/v1/po/{poId}/items?offset=0&limit=-1
   * This is the same endpoint used to build the CSV attachment in downloadPoExcel.
   * Returns the raw items array (skuCode, skuName, poQty, etc.) for ingest.
   * Throws ZeptoAuthExpired on 401/403; throws ZeptoAPIError on other failures.
   */
  async fetchPoItems(poId: string): Promise<Record<string, unknown>[]> {
    const timeout = AbortSignal.timeout(10_000);
    const url = `${env.ZEPTO_BASE_URL}/api/v1/po/${encodeURIComponent(poId)}/items?offset=0&limit=-1`;
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers: this.headers(), signal: timeout });
    } catch (err) {
      throw new ZeptoAPIError(`Zepto items fetch failed for PO ${poId}: ${err}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ZeptoAuthExpired(`auth expired fetching Zepto items for PO ${poId} (HTTP ${res.status})`);
    }
    if (!res.ok) {
      throw new ZeptoAPIError(`Zepto items endpoint HTTP ${res.status} for PO ${poId}`);
    }
    const json = (await res.json().catch(() => null)) as unknown;
    return extractZeptoItemsList(json);
  }
}

// ── private helpers ────────────────────────────────────────────────────────────

/**
 * Parse the Zepto PO attachments envelope and return the PO_DOC presigned S3 URL.
 *
 * Shape: { success, data: [ { documentType: "PO_DOC", documentNumber, s3Url } ] }
 * Prefers the PO_DOC entry; falls back to the first attachment exposing an s3Url.
 */
function extractZeptoAttachmentUrl(rawText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }
  const data = isRecord(parsed) ? parsed.data : parsed;
  const list = Array.isArray(data) ? data : isRecord(data) ? [data] : [];
  const records = list.filter(isRecord);
  const urlOf = (r: Record<string, unknown>): string | null => {
    const v = r.s3Url ?? r.s3url ?? r.url ?? r.documentUrl ?? r.document_url;
    return typeof v === "string" && v.startsWith("http") ? v : null;
  };
  const poDoc = records.find((r) => r.documentType === "PO_DOC" && urlOf(r));
  if (poDoc) return urlOf(poDoc);
  for (const r of records) {
    const u = urlOf(r);
    if (u) return u;
  }
  return null;
}

/**
 * Scan a raw JSON response text for a presigned S3 URL.
 * First tries a regex sweep for the obvious amazonaws.com+X-Amz pattern,
 * then falls back to recursively walking the parsed JSON looking for common
 * URL field names or any string value that looks like a presigned URL.
 */
function findZeptoS3PresignedUrl(rawText: string): string | null {
  // Fast path: regex match for presigned S3 URLs embedded anywhere in the text
  const S3_RE = /https:\/\/[^\s"'<>]+amazonaws\.com[^\s"'<>]+X-Amz-Expires[^\s"'<>]*/;
  const m = rawText.match(S3_RE);
  if (m) return m[0]!;

  // Slow path: parse JSON and walk the object graph
  try {
    return findPresignedUrlInJson(JSON.parse(rawText) as unknown, 0);
  } catch {
    return null;
  }
}

const ZEPTO_URL_FIELD_KEYS = [
  "document_url", "documentUrl", "pdf_url", "pdfUrl",
  "download_url", "downloadUrl", "signed_url", "signedUrl",
  "presigned_url", "presignedUrl", "url",
];

function findPresignedUrlInJson(val: unknown, depth: number): string | null {
  if (depth > 10 || val == null) return null;
  if (typeof val === "string") {
    if (val.includes("amazonaws.com") && val.includes("X-Amz")) return val;
    return null;
  }
  if (Array.isArray(val)) {
    for (const item of val.slice(0, 30)) {
      const r = findPresignedUrlInJson(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    // Prioritise well-known URL field names
    for (const key of ZEPTO_URL_FIELD_KEYS) {
      const v = obj[key];
      if (typeof v === "string" && v.startsWith("https://")) return v;
    }
    // Then recurse into all values
    for (const v of Object.values(obj)) {
      const r = findPresignedUrlInJson(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// ── CSV generation from items endpoint ─────────────────────────────────────────

const ZEPTO_CSV_COL_MAP: Array<{ keys: string[]; header: string }> = [
  { keys: ["sku_code", "skuCode", "product_code", "productCode", "item_code", "itemCode", "vendor_sku_code", "vendorSkuCode", "barcode"], header: "SKU Code" },
  { keys: ["ean_no", "eanNo", "ean", "barcode", "upc"], header: "EAN" },
  // skuName is the Zepto-native product-name field
  { keys: ["skuName", "sku_name", "product_name", "productName", "item_name", "itemName", "name", "description", "product_description"], header: "Product Name" },
  { keys: ["brand", "brand_name", "brandName"], header: "Brand" },
  { keys: ["category", "category_name", "categoryName", "category_display_name", "categoryDisplayName"], header: "Category" },
  // poQty is the Zepto-native ordered-quantity field; grnQty is the confirmed received qty
  { keys: ["poQty", "po_qty", "ordered_qty", "orderedQty", "quantity", "qty", "order_quantity", "orderQuantity", "requested_qty", "requestedQty"], header: "Ordered Qty" },
  { keys: ["asnQty", "asn_qty"], header: "ASN Qty" },
  { keys: ["grnQty", "grn_qty", "receivedQty", "received_qty"], header: "GRN Qty" },
  { keys: ["remainingQty", "remaining_qty"], header: "Remaining Qty" },
  { keys: ["mrp", "max_retail_price", "maxRetailPrice"], header: "MRP" },
  { keys: ["unitPrice", "unit_price", "selling_price", "sellingPrice", "price"], header: "Price" },
  { keys: ["totalValue", "total_value", "total_amount", "totalAmount"], header: "Total Value" },
  { keys: ["hsn_code", "hsnCode", "hsn"], header: "HSN Code" },
  { keys: ["uom", "unit_of_measure", "unitOfMeasure", "unit"], header: "UOM" },
  { keys: ["vendor_code", "vendorCode", "supplier_code", "supplierCode"], header: "Vendor Code" },
];

function extractZeptoItemsList(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  const inner = isRecord(payload.data) ? payload.data : payload;
  if (Array.isArray(inner)) return inner.filter(isRecord);
  if (isRecord(inner)) {
    for (const k of ["items", "poItems", "po_items", "lineItems", "line_items", "records", "results", "list", "data"]) {
      if (Array.isArray(inner[k])) return (inner[k] as unknown[]).filter(isRecord);
    }
    // Fallback: first array-valued field
    for (const v of Object.values(inner)) {
      if (Array.isArray(v)) return (v as unknown[]).filter(isRecord);
    }
  }
  return [];
}

function buildZeptoCsv(poNumber: string, items: Record<string, unknown>[]): string {
  if (items.length === 0) {
    return `PO Number,Note\n${csvCell(poNumber)},No items returned by items endpoint\n`;
  }

  const firstItem = items[0]!;
  const itemKeys = Object.keys(firstItem);
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Find which preferred columns exist in the response
  const activeCols: Array<{ key: string; header: string }> = [];
  for (const colSpec of ZEPTO_CSV_COL_MAP) {
    for (const specKey of colSpec.keys) {
      const actualKey = itemKeys.find(k => normalize(k) === normalize(specKey));
      if (actualKey) {
        activeCols.push({ key: actualKey, header: colSpec.header });
        break;
      }
    }
  }

  // If none matched, output all primitive-valued fields
  if (activeCols.length === 0) {
    for (const key of itemKeys) {
      const v = firstItem[key];
      if (v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        activeCols.push({ key, header: key });
      }
    }
  }

  const headerRow = ["PO Number", ...activeCols.map(c => c.header)].map(csvCell).join(",");
  const dataRows = items.map(item =>
    [poNumber, ...activeCols.map(c => item[c.key])].map(csvCell).join(","),
  );
  return [headerRow, ...dataRows, ""].join("\n");
}

function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
