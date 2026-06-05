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

/**
 * Build a POST body from an optional JSON template, substituting {since} {until}
 * {page} {pageSize} {offset}. Numeric placeholders that stand alone become real
 * numbers (e.g. "page":{page} → "page":0). Falls back to a sensible default shape
 * when no template is configured.
 */
function renderBodyTemplate(
  template: string | undefined,
  vars: { since: string; until: string; page: number; pageSize: number; offset: number },
): Record<string, unknown> {
  if (!template) {
    return {
      filters: { startDate: vars.since, endDate: vars.until },
      pagination: { offset: vars.offset, limit: vars.pageSize, page: vars.page, pageSize: vars.pageSize },
    };
  }
  const filled = template
    .replaceAll('"{page}"', String(vars.page))
    .replaceAll('"{pageSize}"', String(vars.pageSize))
    .replaceAll('"{offset}"', String(vars.offset))
    .replaceAll("{since}", vars.since)
    .replaceAll("{until}", vars.until)
    .replaceAll("{page}", String(vars.page))
    .replaceAll("{pageSize}", String(vars.pageSize))
    .replaceAll("{offset}", String(vars.offset));
  const parsed = JSON.parse(filled) as unknown;
  if (!isRecord(parsed)) throw new InstamartAPIError("INSTAMART_PO_LIST_BODY must be a JSON object");
  return parsed;
}

/**
 * Client for the Swiggy Instamart brand/seller portal data APIs. Authenticates
 * with the OTP access token as `Authorization: Bearer …` (the portal XHRs use
 * this). Mirrors BlinkitClient: a thin `req()` that flags expired auth so the
 * sync layer can re-login once.
 *
 * NOTE: the reference auth script (main.js) covers login only — it does NOT
 * include the PO/orders data endpoints. Those live on the seller portal and
 * authorize off the Bearer token. The grid path is configured via
 * INSTAMART_PO_LIST_PATH (captured from the portal's Network tab Copy-as-cURL).
 * Until set, the PO methods throw InstamartEndpointUnknown with guidance.
 */
export class InstamartClient {
  constructor(private tokens: InstamartTokens) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
      app_version: env.INSTAMART_APP_VERSION,
      authorization: `Bearer ${this.tokens.accessToken}`,
      "content-type": "application/json",
      origin: "https://partner.swiggy.com",
      referer: "https://partner.swiggy.com/",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "x-client-request-id": randomUUID(),
      "x-timestamp": Date.now().toString(),
    };
    // picker.swiggy.com authorizes off the portal SESSION cookie, not the ozone IDP
    // Bearer token (it rejects Bearer with "Token missing"). When the captured cURL's
    // Cookie header is supplied, send it so the data host accepts the request.
    if (env.INSTAMART_PORTAL_COOKIE) h.cookie = env.INSTAMART_PORTAL_COOKIE;
    return h;
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
   * The endpoint (INSTAMART_PO_LIST_PATH) may be a FULL URL on a host different from
   * the auth host — the PO search lives on picker.swiggy.com/api/v1/searchPurchaseOrder
   * (POST), not partner.swiggy.com. Method is driven by INSTAMART_PO_LIST_METHOD and,
   * for POST, the request body by the INSTAMART_PO_LIST_BODY template (placeholders
   * {since}/{until}/{page}/{pageSize}/{offset}). When no template is given a sensible
   * default body is sent. This makes the captured cURL a drop-in: paste path + body.
   */
  async listPurchaseOrders(opts: { since: string; until: string; pageSize?: number; maxPages?: number }): Promise<Record<string, unknown>[]> {
    const path = env.INSTAMART_PO_LIST_PATH;
    if (!path) {
      throw new InstamartEndpointUnknown(
        "INSTAMART_PO_LIST_PATH is not set. Capture the PO grid XHR from the logged-in " +
          "Swiggy Instamart Ads Portal (Network > Fetch/XHR > Copy as cURL) and set the path " +
          "(+ INSTAMART_PO_LIST_METHOD / INSTAMART_PO_LIST_BODY / INSTAMART_PORTAL_COOKIE) " +
          "so the client can page it.",
      );
    }
    const pageSize = opts.pageSize ?? 50;
    const maxPages = opts.maxPages ?? 100;
    const usePost = env.INSTAMART_PO_LIST_METHOD === "POST";
    const out: Record<string, unknown>[] = [];
    for (let page = 0; page < maxPages; page++) {
      const vars = { since: opts.since, until: opts.until, page, pageSize, offset: page * pageSize };
      const payload = usePost
        ? await this.postJson(path, renderBodyTemplate(env.INSTAMART_PO_LIST_BODY, vars))
        : await this.getJson(path, {
            offset: page * pageSize,
            limit: pageSize,
            start_date: opts.since,
            end_date: opts.until,
          });
      const batch = extractList(payload);
      out.push(...batch);
      if (batch.length < pageSize) break;
    }
    return out;
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
