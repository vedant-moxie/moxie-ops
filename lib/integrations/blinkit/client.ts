import "server-only";
import { env } from "@/lib/env";
import type { BlinkitTokens } from "@/lib/integrations/blinkit/auth";

const READY = new Set(["completed", "complete", "success", "finished", "ready", "done"]);
const FAILED = new Set(["failed", "error", "errored"]);

export class BlinkitAPIError extends Error {}
export class BlinkitAuthExpired extends Error {}
export class ReportTimeout extends Error {}

export class BlinkitClient {
  constructor(private tokens: BlinkitTokens) {}

  private headers(): Record<string, string> {
    // The portal auths with the OTP access token; api-key/entity headers are
    // optional and only sent when we have them (env override or derived at login).
    const h: Record<string, string> = {
      accept: "application/json, text/plain, */*",
      app_client: "partnersbiz-web",
      "content-type": "application/json",
      origin: env.BLINKIT_BASE_URL,
      referer: `${env.BLINKIT_BASE_URL}/`,
      service: "partnersbiz",
      "user-agent": "Mozilla/5.0 (compatible; moxie-ops/1.0)",
      access_token: this.tokens.accessToken,
      token: this.tokens.accessToken,
    };
    if (env.BLINKIT_API_KEY) h["x-api-key"] = env.BLINKIT_API_KEY;
    const entityId = env.BLINKIT_ENTITY_ID || this.tokens.entityId;
    const entityType = env.BLINKIT_ENTITY_TYPE || this.tokens.entityType;
    if (entityId) h["X-Entity-Id"] = entityId;
    if (entityType) h["X-Entity-Type"] = entityType;
    return h;
  }

  private async req(path: string, init: RequestInit): Promise<Response> {
    const res = await fetch(`${env.BLINKIT_BASE_URL}${path}`, init);
    if (res.status === 401 || res.status === 403) {
      throw new BlinkitAuthExpired(`auth expired on ${path} (HTTP ${res.status})`);
    }
    return res;
  }

  /** Try the known endpoints that expose the user's entity/vendor mappings. */
  async discoverEntityId(): Promise<string | null> {
    const paths = [
      "/v1/all-user-details/",
      "/v1/get-manufacturer-mappings/",
      "/v1/get-vendor-mappings/",
      "/seller-hub/api/v1/all-user-details/",
    ];
    for (const p of paths) {
      try {
        const res = await fetch(`${env.BLINKIT_BASE_URL}${p}`, { method: "GET", headers: this.headers() });
        const text = await res.text();
        console.log(`[blinkit:entity] GET ${p} → HTTP ${res.status} ${text.slice(0, 240)}`);
        if (!res.ok) continue;
        const json = JSON.parse(text);
        const id = digEntityId(json);
        if (id) {
          console.log(`[blinkit:entity] resolved entity_id=${id} via ${p}`);
          return id;
        }
      } catch (e) {
        console.log(`[blinkit:entity] ${p} error ${e instanceof Error ? e.message : e}`);
      }
    }
    return null;
  }

  setEntityId(id: string) {
    this.tokens.entityId = id;
  }

  /** Raw POST to the report endpoint — returns status + body text (for diagnostics). */
  async rawReport(path: string, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
    const res = await fetch(`${env.BLINKIT_BASE_URL}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return { status: res.status, text: (await res.text()).slice(0, 1200) };
  }

  async triggerReport(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.req(path, { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new BlinkitAPIError(`trigger ${path} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const inner = peelEnvelope(await res.json().catch(() => ({})));
    return isRecord(inner) ? inner : {};
  }

  async listReportRequests(): Promise<Record<string, unknown>[]> {
    const res = await this.req("/v1/report-requests/", { method: "POST", headers: this.headers(), body: "{}" });
    if (!res.ok) throw new BlinkitAPIError(`list report-requests failed: HTTP ${res.status}`);
    const inner = peelEnvelope(await res.json());
    if (Array.isArray(inner)) return inner as Record<string, unknown>[];
    for (const k of ["reports", "results", "report_requests", "items", "data"]) {
      if (isRecord(inner) && Array.isArray(inner[k])) return inner[k] as Record<string, unknown>[];
    }
    return [];
  }

  async downloadRequest(requestId: string): Promise<{ content: Buffer; filename: string | null }> {
    // partnersbiz path genuinely has a double-slash (per po_dump tooling)
    const res = await this.req(`/v1/report-requests/download//${requestId}/`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) throw new BlinkitAPIError(`download ${requestId} failed: HTTP ${res.status}`);
    const inner = peelEnvelope(await res.json());
    const downloadUrl = isRecord(inner) ? inner.download_url : null;
    if (typeof downloadUrl !== "string" || !downloadUrl) {
      throw new BlinkitAPIError(`download ${requestId}: no download_url`);
    }
    // Plain GET on the presigned S3 url (no partnersbiz auth headers)
    const s3 = await fetch(downloadUrl);
    if (!s3.ok) throw new BlinkitAPIError(`s3 download ${requestId} failed: HTTP ${s3.status}`);
    const content = Buffer.from(await s3.arrayBuffer());
    let filename = parseContentDisposition(s3.headers.get("content-disposition") ?? "");
    if (!filename) {
      try {
        filename = new URL(downloadUrl).pathname.split("/").pop() || null;
      } catch {
        filename = null;
      }
    }
    return { content, filename };
  }

  /**
   * Download the PDF for a single partnersbiz PO.
   * Handles both a direct binary response and a JSON envelope with download_url.
   * Throws BlinkitAuthExpired on 401/403, BlinkitAPIError on other failures.
   */
  async downloadPoPdf(poId: string): Promise<{ content: Buffer; filename: string }> {
    return this.downloadPoDocument(poId, "pdf");
  }

  /**
   * Download the Excel for a single partnersbiz PO.
   * Tries /excel/ first, falls back to /xlsx/ if the first path returns 404.
   */
  async downloadPoExcel(poId: string): Promise<{ content: Buffer; filename: string }> {
    try {
      return await this.downloadPoDocument(poId, "excel");
    } catch (err) {
      if (err instanceof BlinkitAPIError && /404/.test(String(err.message))) {
        return this.downloadPoDocument(poId, "xlsx");
      }
      throw err;
    }
  }

  private async downloadPoDocument(
    poId: string,
    fmt: "pdf" | "excel" | "xlsx",
  ): Promise<{ content: Buffer; filename: string }> {
    const path = `/v1/client-po-details/${poId}/${fmt}/`;
    const res = await this.req(path, { method: "GET", headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      throw new BlinkitAPIError(`PO ${fmt} ${poId} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const contentType = res.headers.get("content-type") ?? "";

    // SPA catch-all: partnersbiz returns its React index.html (HTTP 200, text/html) when a
    // path isn't a real API route.  Treat it as a missing endpoint, not a successful download.
    if (contentType.includes("text/html")) {
      throw new BlinkitAPIError(`PO ${fmt} ${poId}: endpoint returned HTML — path not a valid API route for this id`);
    }

    // JSON envelope: partnersbiz wraps presigned S3 URLs in {"status":1,"data":{"signed_url":"..."}}
    // The key may be signed_url (confirmed live), download_url, or url.
    if (contentType.includes("application/json") || contentType.includes("text/plain")) {
      const inner = peelEnvelope(await res.json().catch(() => ({})));
      const downloadUrl = isRecord(inner)
        ? (inner.download_url ?? inner.url ?? inner.signed_url ?? null)
        : null;
      if (typeof downloadUrl === "string" && downloadUrl) {
        const s3 = await fetch(downloadUrl, { signal: AbortSignal.timeout(15_000) });
        if (!s3.ok) throw new BlinkitAPIError(`PO ${fmt} ${poId} S3 fetch failed: HTTP ${s3.status}`);
        const content = Buffer.from(await s3.arrayBuffer());
        const filename =
          parseContentDisposition(s3.headers.get("content-disposition") ?? "") ??
          new URL(downloadUrl).pathname.split("/").pop() ??
          `${poId}.${fmt === "xlsx" ? "xlsx" : fmt}`;
        return { content, filename };
      }
      throw new BlinkitAPIError(`PO ${fmt} ${poId}: unexpected JSON response without download_url/signed_url`);
    }
    // Direct binary response
    const content = Buffer.from(await res.arrayBuffer());
    const filename =
      parseContentDisposition(res.headers.get("content-disposition") ?? "") ??
      `${poId}.${fmt === "xlsx" ? "xlsx" : fmt}`;
    return { content, filename };
  }

  /** Trigger → poll → download. Returns the report file bytes. */
  async runReport(opts: {
    triggerPath: string;
    triggerBody: Record<string, unknown>;
    reportKind: string;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  }): Promise<{ content: Buffer; filename: string | null }> {
    const triggeredAt = new Date();
    const triggerResponse = await this.triggerReport(opts.triggerPath, opts.triggerBody);
    let requestId = extractRequestId(triggerResponse);

    const deadline = Date.now() + (opts.maxWaitMs ?? 300_000);
    let lastStatus: string | null = null;

    for (;;) {
      const listing = await this.listReportRequests();
      const entry = findEntry(listing, requestId, triggeredAt, opts.reportKind);
      if (entry) {
        if (!requestId) requestId = extractRequestId(entry);
        const status = normalizeStatus(entry);
        if (status !== lastStatus) lastStatus = status;
        if (READY.has(status)) break;
        if (FAILED.has(status)) throw new BlinkitAPIError(`report failed: status=${status}`);
      }
      if (Date.now() > deadline) {
        throw new ReportTimeout(`${opts.reportKind} report not ready (last_status=${lastStatus})`);
      }
      await new Promise((r) => setTimeout(r, opts.pollIntervalMs ?? 8_000));
    }
    if (!requestId) throw new BlinkitAPIError("report ready but no request id resolved");
    return this.downloadRequest(requestId);
  }
}

// ── helpers (ported from po_dump tooling) ─────────────────
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursively hunt for an entity/manufacturer id in a mappings response. */
function digEntityId(obj: unknown, depth = 0): string | null {
  if (depth > 6 || obj == null) return null;
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const r = digEntityId(x, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (isRecord(obj)) {
    for (const k of ["entity_id", "entityId", "manufacturer_id", "manufacturerId", "id"]) {
      const v = obj[k];
      if ((typeof v === "string" || typeof v === "number") && String(v) && /entity|manufacturer|^id$/i.test(k)) {
        return String(v);
      }
    }
    for (const v of Object.values(obj)) {
      const r = digEntityId(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function peelEnvelope(payload: unknown): unknown {
  if (isRecord(payload) && "status" in payload && "data" in payload && "instance_name" in payload) {
    return payload.data;
  }
  return payload;
}

const ID_KEYS = ["id", "request_id", "report_request_id", "uuid"];
const STATUS_KEYS = ["status", "state", "report_status"];
const CREATED_KEYS = ["created_at", "created", "requested_at", "createdAt", "timestamp"];
const TYPE_KEYS = ["report_type", "type", "report_name", "name"];

function extractRequestId(obj: unknown): string | null {
  if (!isRecord(obj)) return null;
  for (const k of ID_KEYS) {
    const v = obj[k];
    if ((typeof v === "string" || typeof v === "number") && String(v)) return String(v);
  }
  for (const w of ["data", "result", "report_request"]) {
    const nested = obj[w];
    if (isRecord(nested)) {
      for (const k of ID_KEYS) {
        const v = nested[k];
        if ((typeof v === "string" || typeof v === "number") && String(v)) return String(v);
      }
    }
  }
  return null;
}

function normalizeStatus(entry: Record<string, unknown>): string {
  for (const k of STATUS_KEYS) {
    const v = entry[k];
    if (typeof v === "string") return v.trim().toLowerCase();
  }
  return "";
}

function entryCreatedAt(entry: Record<string, unknown>): Date | null {
  for (const k of CREATED_KEYS) {
    const v = entry[k];
    if (!v) continue;
    if (typeof v === "number") {
      const secs = v > 1e11 ? v / 1000 : v;
      return new Date(secs * 1000);
    }
    if (typeof v === "string") {
      const d = new Date(v.replace("Z", "+00:00"));
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

function entryTypeMatches(entry: Record<string, unknown>, reportKind: string): boolean {
  const needle = reportKind.toLowerCase().replace(/_/g, "");
  for (const k of TYPE_KEYS) {
    const v = entry[k];
    if (typeof v === "string" && v.toLowerCase().replace(/[_-]/g, "").includes(needle)) return true;
  }
  return false;
}

function findEntry(
  listing: Record<string, unknown>[],
  requestId: string | null,
  triggeredAt: Date,
  reportKind: string,
): Record<string, unknown> | null {
  if (requestId) {
    return listing.find((e) => String(extractRequestId(e)) === String(requestId)) ?? null;
  }
  const candidates: [Date, Record<string, unknown>][] = [];
  for (const e of listing) {
    if (!entryTypeMatches(e, reportKind)) continue;
    const ts = entryCreatedAt(e);
    if (ts && ts.getTime() >= triggeredAt.getTime() - 60_000) candidates.push([ts, e]);
  }
  candidates.sort((a, b) => b[0].getTime() - a[0].getTime());
  return candidates[0]?.[1] ?? null;
}

const CD_RE = /filename\*?=(?:"([^"]+)"|([^;]+))/i;
function parseContentDisposition(header: string): string | null {
  if (!header) return null;
  const m = header.match(CD_RE);
  if (!m) return null;
  let raw = (m[1] || m[2] || "").trim();
  if (raw.toLowerCase().startsWith("utf-8''")) raw = decodeURIComponent(raw.slice(7));
  return raw || null;
}
