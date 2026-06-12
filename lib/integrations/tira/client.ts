import "server-only";
import { env } from "@/lib/env";
import type { TiraTokens } from "@/lib/integrations/tira/auth";

export class TiraAPIError extends Error {}
export class TiraAuthExpired extends Error {}

const BASE = "https://srm-rrscm.ril.com";
const MASTER_PATH = `${BASE}/srm/po-data/api/v1/master`;
const ITEMS_PATH = `${BASE}/srm/po-data/api/v1/purchase-order/items`;
const PRINT_PATH = `${BASE}/srm/po-data/api/v1/purchase-orders/print`;

export type RawTiraPo = Record<string, unknown>;
export type RawTiraItem = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Build cookie string from MYSAPSSO2 value + TIRA_PORTAL_COOKIE extras. */
export function buildCookieHeader(ssoCookie: string): string {
  if (env.TIRA_PORTAL_COOKIE) {
    // If user pasted the full cookie string, use it directly.
    const c = env.TIRA_PORTAL_COOKIE.trim();
    if (c.includes("MYSAPSSO2=") || c.includes("BIGip")) return c;
  }
  const parts: string[] = [];
  if (ssoCookie) parts.push(`MYSAPSSO2=${ssoCookie}`);
  return parts.join("; ");
}

function baseHeaders(tokens: TiraTokens, referer?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
    authorization: `Bearer ${tokens.accessToken}`,
    "content-type": "application/json",
    connection: "keep-alive",
    host: "srm-rrscm.ril.com",
    origin: BASE,
    referer: referer ?? `${BASE}/purchase-order/new`,
    "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent":
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36`,
  };
  const cookie = buildCookieHeader(tokens.ssoCookie);
  if (cookie) headers.cookie = cookie;
  return headers;
}

async function post<T>(url: string, headers: Record<string, string>, body: unknown): Promise<T> {
  const bodyStr = JSON.stringify(body);
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-length": String(Buffer.byteLength(bodyStr)) },
    body: bodyStr,
  });

  if (res.status === 401 || res.status === 403) {
    throw new TiraAuthExpired(`Tira auth expired (HTTP ${res.status})`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new TiraAPIError(`Tira POST ${url} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TiraAPIError(`Tira POST ${url} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

export interface PoListQuery {
  since?: string;
  until?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Fetch the PO list from the master endpoint.
 *
 * The confirmed action is READ_ALL_PO_VIEW_AND_EXCEL_CONFIG — despite the name,
 * it returns the open PO list alongside column config (1.0 kB for a small vendor).
 * Override with TIRA_PO_LIST_ACTION if the portal uses a different action.
 */
export async function listPurchaseOrders(
  tokens: TiraTokens,
  query: PoListQuery = {},
): Promise<RawTiraPo[]> {
  const action = env.TIRA_PO_LIST_ACTION || "READ_ALL_PO_VIEW_AND_EXCEL_CONFIG";

  let body: Record<string, unknown> = {};
  if (env.TIRA_PO_LIST_BODY) {
    const rendered = env.TIRA_PO_LIST_BODY
      .replace(/\{since\}/g, query.since ?? "")
      .replace(/\{until\}/g, query.until ?? "")
      .replace(/\{page\}/g, String(query.page ?? 1))
      .replace(/\{pageSize\}/g, String(query.pageSize ?? 50));
    try { body = JSON.parse(rendered); } catch { /* use empty body */ }
  }

  const data = await post<unknown>(
    MASTER_PATH,
    { ...baseHeaders(tokens), action },
    body,
  );

  // Detect API-level error responses (messageType !== SUCCESS means an error)
  if (isRecord(data) && data.messageType && data.messageType !== "SUCCESS") {
    throw new TiraAPIError(
      `Tira master error (action=${action}): ${data.message ?? JSON.stringify(data)}`,
    );
  }

  if (Array.isArray(data)) return data as RawTiraPo[];
  if (isRecord(data)) {
    for (const key of ["data", "poList", "purchaseOrders", "records", "result", "pos", "items"]) {
      if (Array.isArray(data[key])) return data[key] as RawTiraPo[];
    }
    // SAP SRM sometimes returns all PO rows as an array under an arbitrary key.
    for (const val of Object.values(data)) {
      if (Array.isArray(val) && val.length > 0 && isRecord(val[0])) return val as RawTiraPo[];
    }
    console.warn("[tira] listPurchaseOrders: unrecognised shape, keys:", Object.keys(data));
    return [data];
  }
  console.warn("[tira] listPurchaseOrders: unexpected type", typeof data);
  return [];
}

/**
 * Fetch line items for a single PO from /purchase-order/items.
 *
 * Confirmed request body (51 bytes):
 *   { "purchaseOrders": ["5000478343"], "action": "SCREEN" }
 *
 * Set TIRA_PO_ITEMS_BODY (with {poId} placeholder) to override.
 */
export async function fetchPoItems(
  tokens: TiraTokens,
  poId: string,
): Promise<RawTiraItem[]> {
  let body: Record<string, unknown>;
  if (env.TIRA_PO_ITEMS_BODY) {
    const rendered = env.TIRA_PO_ITEMS_BODY.replace(/\{poId\}/g, poId);
    try { body = JSON.parse(rendered); } catch { body = {}; }
  } else {
    body = { purchaseOrders: [poId], action: "SCREEN" };
  }

  const data = await post<unknown>(
    ITEMS_PATH,
    baseHeaders(tokens, `${BASE}/purchase-order/order-detail/purchase-order-detail`),
    body,
  );

  if (Array.isArray(data)) return data as RawTiraItem[];
  if (isRecord(data)) {
    for (const key of ["items", "lineItems", "data", "result", "poItems", "purchaseOrderItems", "purchaseOrders"]) {
      if (Array.isArray(data[key])) return data[key] as RawTiraItem[];
    }
    return [data];
  }
  return [];
}

/**
 * Download the PO PDF from /purchase-orders/print.
 *
 * Returns raw PDF bytes. Filename on the portal: {poNumber}.pdf.pdf
 *
 * Confirmed request body (33 bytes):
 *   { "purchaseOrders": ["5000478343"] }
 *
 * Set TIRA_PO_PRINT_BODY with {poId} placeholder to override.
 */
export async function downloadPoPdf(
  tokens: TiraTokens,
  poId: string,
): Promise<Buffer> {
  let body: Record<string, unknown>;
  if (env.TIRA_PO_PRINT_BODY) {
    const rendered = env.TIRA_PO_PRINT_BODY.replace(/\{poId\}/g, poId);
    try { body = JSON.parse(rendered); } catch { body = {}; }
  } else {
    body = { purchaseOrders: [poId] };
  }

  const bodyStr = JSON.stringify(body);
  const headers = baseHeaders(tokens, `${BASE}/purchase-order/order-detail/purchase-order-detail`);
  headers["accept"] = "application/json, text/plain, */*";
  headers["content-length"] = String(Buffer.byteLength(bodyStr));

  const res = await fetch(PRINT_PATH, {
    method: "POST",
    headers,
    body: bodyStr,
  });

  if (res.status === 401 || res.status === 403) throw new TiraAuthExpired(`Tira auth expired (HTTP ${res.status})`);
  if (!res.ok) {
    const text = await res.text();
    throw new TiraAPIError(`Tira print failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/** Thin class wrapper — mirrors other channel clients. */
export class TiraClient {
  constructor(private readonly tokens: TiraTokens) {}

  listPurchaseOrders(query?: PoListQuery): Promise<RawTiraPo[]> {
    return listPurchaseOrders(this.tokens, query);
  }

  fetchPoItems(poId: string): Promise<RawTiraItem[]> {
    return fetchPoItems(this.tokens, poId);
  }

  downloadPoPdf(poId: string): Promise<Buffer> {
    return downloadPoPdf(this.tokens, poId);
  }
}
